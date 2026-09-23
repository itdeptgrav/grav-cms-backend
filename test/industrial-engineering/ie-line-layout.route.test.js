// test/industrial-engineering/ie-line-layout.route.test.js
//
// IE CHUNK 6A — THE LINE LAYOUT AND ITS BALANCE, AT THE WIRE.
//
// A layout turns approved standard times into the figures a line is balanced
// on, so the claims worth holding are the ones that keep those figures
// defensible:
//
//   · only an APPROVED standard time may drive a balance — a bulletin whose
//     rows are not all approved cannot have a layout at all, and the refusal
//     names every row and why;
//   · the minutes are captured by the SERVER from the approved study; a client
//     cannot send a time, a workload, a total or an efficiency;
//   · the layout binds to one exact bulletin revision and its ordered row
//     identities, and when the bulletin moves it is reported SOURCE_CHANGED,
//     never rebased and never deleted;
//   · every row is placed exactly once — unknown, duplicate and foreign rows
//     are refused, and unplaced rows are a coverage gap rather than a silently
//     smaller total;
//   · an empty station counts towards the balance, and a line with no work
//     produces null metrics with a reason rather than NaN, Infinity or 0%;
//   · station ids survive reordering and relabelling;
//   · and nothing here assigns a person or a machine, plans capacity, or
//     touches the bulletin, the operation library or a method study.
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
async function world(name, { minutes = [1, 1.2, 0.8, 1.5], approveAll = true } = {}) {
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

  const operations = [];
  for (let i = 0; i < minutes.length; i += 1) {
    operations.push((await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation);
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

/* ══ 1. OPENING A LAYOUT ══════════════════════════════════════════════════ */

describe("opening a layout", () => {
  test("it binds to the exact bulletin revision and captures approved times", async () => {
    const w = await world("Open");
    const res = await open(w.maker, w);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const l = res.body.layout;
    expect(l.status).toBe("DRAFT");
    expect(l.revision).toBe(1);
    expect(l.source.bulletinRevision).toBe(w.fileRevision);
    expect(l.source.currentBulletinRevision).toBe(w.fileRevision);
    expect(l.source.state).toBe("CURRENT");
    expect(l.source.rows.map((r) => r.rowId)).toEqual(w.rows.map((r) => r.rowId));
    expect(l.source.rows.map((r) => r.standardTimeMinutes)).toEqual([1, 1.2, 0.8, 1.5]);
    /* The server captured WHICH approval each figure came from. */
    for (let i = 0; i < l.source.rows.length; i += 1) {
      expect(l.source.rows[i]).toMatchObject({
        operationCode: `OP-${i + 1}`,
        standardTimeSource: "MANUAL_OVERRIDE",
        methodStudyId: w.approvals[i].studyId,
        approvedSubmissionId: w.approvals[i].submission,
      });
      expect(l.source.rows[i].approvedAt).toEqual(expect.any(String));
    }
    expect(l.stations).toEqual([]);
    /* CHUNK 7C2: `canApprove` is now a real answer about THIS record — a draft
       that can prove which approved bulletin version it balances. It does not
       mean the gates would pass; `readiness` answers that. */
    expect(l.canApprove).toBe(true);
    expect(l.versionBacked).toBe(true);
    expect(l.approval).toBeNull();
    expect(l.allocates).toBe(false);
    expect(l.history.map((e) => e.type)).toEqual(["LINE_LAYOUT_CREATED"]);

    /* Nothing is placed yet, so every row is a coverage gap and there is no
       balance — not a balance of zero. */
    expect(l.metrics).toMatchObject({
      totalWorkContentMinutes: 0, stationCount: 0,
      pitchMinutes: null, bottleneckMinutes: null,
      balanceEfficiencyPercent: null, balanceLossPercent: null,
      available: false, unavailableReason: "NO_STATIONS", rounding: "HALF_UP_4DP",
    });
    const codes = l.readiness.gaps.map((g) => g.code);
    expect(codes).toContain("IE_LAYOUT_ROWS_UNASSIGNED");
    expect(codes).toContain("IE_LAYOUT_NO_STATIONS");
    expect(codes).toContain("IE_LAYOUT_METRICS_UNAVAILABLE");
    expect(l.readiness.gaps.find((g) => g.code === "IE_LAYOUT_ROWS_UNASSIGNED").rowIds)
      .toEqual(w.rows.map((r) => r.rowId));
  });

  test("opening twice resumes the same layout", async () => {
    const w = await world("Idempotent");
    const first = await open(w.maker, w);
    const second = await open(w.maker, w);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.layout.layoutId).toBe(first.body.layout.layoutId);
    expect(await IeLineLayout.countDocuments({})).toBe(1);

    const many = await Promise.all([open(w.maker, w), open(w.maker, w), open(w.maker, w)]);
    expect(many.every((r) => r.status === 200 && r.body.created === false)).toBe(true);
    expect(await IeLineLayout.countDocuments({})).toBe(1);

    /* The identity is the bulletin revision AND the source fingerprint: a
       later approval of the same row is a different source and earns its own
       layout. The earlier revision-only index is gone, not merely unused. */
    const indexes = await IeLineLayout.collection.indexes();
    expect(indexes.find((i) => i.name === "ie_line_layout_one_draft_per_source"))
      .toMatchObject({
        unique: true,
        key: { companyId: 1, ieStyleFileId: 1, bulletinRevision: 1, sourceFingerprint: 1 },
        partialFilterExpression: { status: "DRAFT" },
      });
    expect(indexes.find((i) => i.name === "ie_line_layout_one_draft_per_bulletin_revision")).toBeUndefined();
  });

  test("a bulletin with no approved version refuses the whole layout", async () => {
    /* CHUNK 7C2. A row without an approved standard time is now caught one step
       earlier: such a bulletin cannot be submitted at all, so the file never
       gains an approved version — and without one there is nothing to balance a
       line against. The refusal moved from "these rows have no approved time"
       to "this file has no approved bulletin", which is the same fact stated
       where it is now decided. */
    const w = await world("NotApproved", { approveAll: false });
    expect(w.bulletinVersion).toBeNull();

    const res = await open(w.maker, w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_BULLETIN_NOT_APPROVED");
    expect(res.body.error.details.fileId).toBe(String(w.fileId));
    expect(await IeLineLayout.countDocuments({})).toBe(0);

    /* And the reason it has none is still reported by the submit gate itself. */
    const file = await IeStyleFile.findById(w.fileId).lean();
    const submitted = await call(`/engineering-files/${w.fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    expect(submitted.body.error.details.gaps.some(
      (g) => g.code === "IE_BULLETIN_ROW_NO_APPROVED_TIME" && g.rowId === w.rows[3].rowId,
    )).toBe(true);

    const stillNot = await open(w.maker, w);
    expect(stillNot.status).toBe(409);
    expect(await IeLineLayout.countDocuments({})).toBe(0);
  });

  test("an editor opens; a viewer reads and cannot open", async () => {
    const w = await world("Roles");
    const opened = await open(w.maker, w);
    const viewer = await viewerIn(w.co);

    expect((await readLayout(viewer, w, opened.body.layout.layoutId)).status).toBe(200);
    expect((await call(`/engineering-files/${w.fileId}/line-layouts`, { token: viewer.token, company: w.co._id })).status).toBe(200);

    const refusedOpen = await open(viewer, w);
    expect(refusedOpen.status).toBe(403);
    expect(refusedOpen.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    const refusedEdit = await patchLayout(viewer, w, opened.body.layout.layoutId, {
      expectedRevision: 1, stations: [],
    });
    expect(refusedEdit.status).toBe(403);
    expect((await IeLineLayout.findById(opened.body.layout.layoutId).lean()).revision).toBe(1);
  });

  test("opening takes no authority from the body", async () => {
    const w = await world("BodyAuthority");
    for (const body of [
      { companyId: String(w.co._id) },
      { bulletinRevision: 9 },
      { sourceRows: [] },
      { totalWorkContentMinutes: 99 },
    ]) {
      const res = await call(`/engineering-files/${w.fileId}/line-layouts`, {
        method: "POST", token: w.maker.token, company: w.co._id, body,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeLineLayout.countDocuments({})).toBe(0);
  });

  test("a foreign file and a foreign layout disclose nothing", async () => {
    const theirs = await world("Theirs");
    const theirLayout = (await open(theirs.maker, theirs)).body.layout;
    const mine = await world("Mine");

    const foreignRead = await readLayout(mine.maker, mine, theirLayout.layoutId);
    const inventedRead = await readLayout(mine.maker, mine, new mongoose.Types.ObjectId());
    expect(foreignRead.status).toBe(404);
    expect(foreignRead.body).toEqual(inventedRead.body);
    expect(foreignRead.body.error.code).toBe("IE_LINE_LAYOUT_NOT_FOUND");
    expect(JSON.stringify(foreignRead.body)).not.toMatch(/OP-1|bulletinRevision|standardTime/);

    const foreignList = await call(`/engineering-files/${theirs.fileId}/line-layouts`, {
      token: mine.maker.token, company: mine.co._id,
    });
    expect(foreignList.status).toBe(404);
    const foreignPatch = await patchLayout(mine.maker, mine, theirLayout.layoutId, {
      expectedRevision: 1, stations: [],
    });
    expect(foreignPatch.status).toBe(404);
    expect((await IeLineLayout.findById(theirLayout.layoutId).lean()).revision).toBe(1);
  });
});

/* ══ 2. STATIONS AND ASSIGNMENTS ══════════════════════════════════════════ */

describe("arranging the line", () => {
  async function opened(name, opts) {
    const w = await world(name, opts);
    const res = await open(w.maker, w);
    expect(res.status).toBe(201);
    return { w, layout: res.body.layout };
  }

  test("stations and assignments are ordered, and the server supplies the minutes", async () => {
    const { w, layout } = await opened("Arrange");
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);

    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [
        station([r1, r2], { label: "Front", note: "guide fitted" }),
        station([r3, r4], { label: "Back" }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const stations = res.body.layout.stations;
    expect(stations.map((s) => s.sequence)).toEqual([1, 2]);
    expect(stations.every((s) => /^stn_[0-9a-f]{18}$/.test(s.stationId))).toBe(true);
    expect(stations[0]).toMatchObject({ label: "Front", note: "guide fitted", workloadMinutes: 2.2 });
    expect(stations[0].assignments.map((a) => [a.rowId, a.sequence, a.operationCode, a.standardTimeMinutes]))
      .toEqual([[r1, 1, "OP-1", 1], [r2, 2, "OP-2", 1.2]]);
    expect(stations[1]).toMatchObject({ workloadMinutes: 2.3, isBottleneck: true, idleMinutes: 0 });
    /* 2.3 − 2.2 is 0.1 here, not 0.09999999999999987: the scaled arithmetic. */
    expect(stations[0].idleMinutes).toBe(0.1);

    /* THE BALANCE: 4.5 total over 2 stations, bottleneck 2.3.
       efficiency = 4.5 ÷ (2 × 2.3) × 100 = 97.8261, loss = 2.1739. */
    expect(res.body.layout.metrics).toMatchObject({
      totalWorkContentMinutes: 4.5,
      stationCount: 2,
      pitchMinutes: 2.25,
      bottleneckMinutes: 2.3,
      balanceEfficiencyPercent: 97.8261,
      balanceLossPercent: 2.1739,
      available: true,
      unavailableReason: null,
    });
    /* Every row is placed, so coverage is complete — and Chunk 6B adds one
       remaining gap. These operations never had their requirements configured,
       so what they need cannot be known and compatibility is UNKNOWN rather
       than a readiness anybody can act on. Readiness says so instead of calling
       an unproven line ready. */
    expect(res.body.layout.readiness.gaps.map((g) => g.code))
      .toEqual(["IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED"]);
    expect(res.body.layout.machineTypeCompatibility).toMatchObject({
      evaluated: 4, compatible: 0, incompatible: 0, unknown: 4, state: "UNKNOWN",
    });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].type).toBe("LINE_LAYOUT_EDITED");
  });

  test("an intentionally empty station counts, and a line with no work has no balance", async () => {
    const { w, layout } = await opened("EmptyStation");
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);

    const withEmpty = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [station([r1, r2]), station([r3, r4]), station([], { label: "Spare" })],
    });
    /* 4.5 ÷ (3 × 2.3) × 100 = 65.2174 — the empty station is in the divisor,
       because somebody standing idle in the line is part of the balance. */
    expect(withEmpty.body.layout.metrics).toMatchObject({
      stationCount: 3, pitchMinutes: 1.5, bottleneckMinutes: 2.3,
      balanceEfficiencyPercent: 65.2174, balanceLossPercent: 34.7826,
    });
    expect(withEmpty.body.layout.readiness.gaps.map((g) => g.code)).toContain("IE_LAYOUT_EMPTY_STATION");

    /* Stations with no work at all: null metrics and a reason, never 0%. */
    const noWork = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: withEmpty.body.layout.revision,
      stations: [station([]), station([])],
    });
    expect(noWork.body.layout.metrics).toMatchObject({
      totalWorkContentMinutes: 0, stationCount: 2, pitchMinutes: 0,
      bottleneckMinutes: 0, balanceEfficiencyPercent: null, balanceLossPercent: null,
      available: false, unavailableReason: "NO_WORK_ASSIGNED",
    });
    for (const v of [noWork.body.layout.metrics.balanceEfficiencyPercent, noWork.body.layout.metrics.balanceLossPercent]) {
      expect(v).toBeNull();
    }
    expect(JSON.stringify(noWork.body.layout.metrics)).not.toMatch(/Infinity|NaN|null,"balanceLossPercent":0/);
    expect(noWork.body.layout.readiness.gaps.map((g) => g.code)).toContain("IE_LAYOUT_METRICS_UNAVAILABLE");
  });

  test("unplaced rows are a coverage gap, not a smaller total", async () => {
    const { w, layout } = await opened("Coverage");
    const [r1, r2] = w.rows.map((r) => r.rowId);

    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1, r2])],
    });
    expect(res.status).toBe(200);
    expect(res.body.layout.metrics.totalWorkContentMinutes).toBe(2.2);
    const gap = res.body.layout.readiness.gaps.find((g) => g.code === "IE_LAYOUT_ROWS_UNASSIGNED");
    expect(gap.rowIds).toEqual([w.rows[2].rowId, w.rows[3].rowId]);
    expect(gap.operationCodes).toEqual(["OP-3", "OP-4"]);
    expect(res.body.layout.readiness.ready).toBe(false);
    /* The total is honest about what is placed; the gap says what is not. */
    expect(res.body.layout.source.rowCount).toBe(4);
  });

  test("station ids survive reordering and relabelling", async () => {
    const { w, layout } = await opened("StableStations");
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);
    const first = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1, r2], { label: "A" }), station([r3, r4], { label: "B" })],
    });
    const [a, b] = first.body.layout.stations;

    const flipped = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: first.body.layout.revision,
      stations: [
        { stationId: b.stationId, label: "B renamed", assignments: [{ rowId: r4 }, { rowId: r3 }] },
        { stationId: a.stationId, label: "A", assignments: [{ rowId: r1 }, { rowId: r2 }] },
        station([], { label: "New" }),
      ],
    });

    expect(flipped.status).toBe(200);
    const stations = flipped.body.layout.stations;
    expect(stations.map((s) => s.stationId).slice(0, 2)).toEqual([b.stationId, a.stationId]);
    expect(stations.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(stations[0].label).toBe("B renamed");
    expect(stations[0].assignments.map((x) => x.rowId)).toEqual([r4, r3]);
    expect(stations[2].stationId).not.toBe(a.stationId);
    expect(flipped.body.events[0].changed).toEqual(expect.arrayContaining(["stations_added"]));
  });

  test("unknown, duplicate and cross-file rows are refused", async () => {
    const { w, layout } = await opened("RowRefusals");
    const other = await world("OtherFile");
    const [r1] = w.rows.map((r) => r.rowId);

    const unknown = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station(["row_deadbeefdeadbeefde"])],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("IE_LINE_LAYOUT_ROW_NOT_IN_SOURCE");

    const crossFile = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([other.rows[0].rowId])],
    });
    expect(crossFile.status).toBe(400);
    expect(crossFile.body.error.code).toBe("IE_LINE_LAYOUT_ROW_NOT_IN_SOURCE");
    expect(crossFile.body.error.details.rowId).toBe(other.rows[0].rowId);

    const duplicate = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1]), station([r1])],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe("IE_LINE_LAYOUT_ROW_DUPLICATE");
    expect(duplicate.body.error.details.fieldErrors[0].rowId).toBe(r1);

    const unknownStation = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [{ stationId: "stn_deadbeefdeadbeefde", assignments: [] }],
    });
    expect(unknownStation.status).toBe(400);
    expect(unknownStation.body.error.code).toBe("IE_LINE_LAYOUT_STATION_INVALID");

    /* No partial write from any of it. */
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.revision).toBe(1);
    expect(stored.stations).toEqual([]);
  });

  test("a client cannot supply a time, a workload or a metric", async () => {
    const { w, layout } = await opened("NoClientNumbers");
    const [r1] = w.rows.map((r) => r.rowId);

    for (const body of [
      { expectedRevision: 1, stations: [station([r1])], totalWorkContentMinutes: 99 },
      { expectedRevision: 1, stations: [station([r1])], balanceEfficiencyPercent: 100 },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], stationWorkloadMinutes: 0.1 }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1, standardTimeMinutes: 0.01 }] }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1, operationCode: "FAKE" }] }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], employeeId: "GR0067" }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], machineId: String(new mongoose.Types.ObjectId()) }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], targetOutput: 500 }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], shift: "A" }] },
      { expectedRevision: 1, stations: [{ assignments: [{ rowId: r1 }], colour: "blue" }] },
    ]) {
      const res = await patchLayout(w.maker, w, layout.layoutId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }

    /* And the stored minutes are the approved ones, whatever anybody sends. */
    const saved = await patchLayout(w.maker, w, layout.layoutId, { expectedRevision: 1, stations: [station([r1])] });
    expect(saved.body.layout.stations[0].assignments[0].standardTimeMinutes).toBe(1);
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.stations[0].assignments[0].standardTimeMinutes).toBe(1);
    expect(JSON.stringify(stored)).not.toMatch(/employeeId|machineId|serialNumber|targetOutput|shift|capacity/i);
  });

  test("a PATCH without stations is refused rather than read as clearing the line", async () => {
    const { w, layout } = await opened("StationsRequired");
    const [r1] = w.rows.map((r) => r.rowId);
    const saved = await patchLayout(w.maker, w, layout.layoutId, { expectedRevision: 1, stations: [station([r1])] });
    expect(saved.status).toBe(200);

    const res = await patchLayout(w.maker, w, layout.layoutId, { expectedRevision: saved.body.layout.revision });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("stations");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).stations).toHaveLength(1);
  });
});

/* ══ 3. SOURCE BINDING, CONCURRENCY AND NO-OPS ════════════════════════════ */

describe("the bulletin underneath", () => {
  async function balanced(name) {
    const w = await world(name);
    const layout = (await open(w.maker, w)).body.layout;
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1, r2]), station([r3, r4])],
    });
    expect(saved.status).toBe(200);
    return { w, layout: saved.body.layout };
  }

  test("editing the bulletin leaves a version-backed layout exactly where it is", async () => {
    /* CORRECTED for Chunk 7C2. This test used to prove that removing a bulletin
       row made the layout SOURCE_CHANGED. That was the 6A contract, where a
       layout was a balance of a mutable draft. A layout is now a balance of an
       approved version, and the draft being edited here is the successor — so
       the layout stays current, and the way to plan against the new bulletin is
       to have it approved as the next version. */
    const { w, layout } = await balanced("SourceChanged");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    const edited = await call(`/engineering-files/${w.fileId}/bulletin`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: {
        expectedRevision: w.fileRevisionNow,
        rows: w.rows.slice(0, 3).map((r) => ({ rowId: r.rowId, ieOperationId: r.ieOperationId, proposedSamMinutes: 1 })),
      },
    });
    expect(edited.status).toBe(200);

    const after = await readLayout(w.maker, w, layout.layoutId);
    expect(after.status).toBe(200);
    expect(after.body.layout.source.state).toBe("CURRENT");
    expect(after.body.layout.source.bulletinRevision).toBe(w.fileRevision);
    expect(after.body.layout.editable).toBe(true);
    expect(after.body.layout.readiness.gaps.map((g) => g.code)).not.toContain("IE_LAYOUT_SOURCE_CHANGED");
    /* The balance it recorded is intact — same rows, same minutes, same total. */
    expect(after.body.layout.metrics.totalWorkContentMinutes).toBe(4.5);
    expect(after.body.layout.source.rows).toHaveLength(4);

    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.sourceRows).toEqual(before.sourceRows);
    expect(stored.stations).toEqual(before.stations);
    expect(stored.revision).toBe(before.revision);

    /* And opening again still resumes this one, because the approved version
       has not moved — the successor draft is not something to balance yet. */
    const again = await open(w.maker, w);
    expect(again.body.created).toBe(false);
    expect(again.body.layout.layoutId).toBe(layout.layoutId);
    expect(await IeLineLayout.countDocuments({ ieStyleFileId: new mongoose.Types.ObjectId(w.fileId) })).toBe(1);
  });

  test("a stale revision is refused, and two simultaneous edits leave one winner", async () => {
    const { w, layout } = await balanced("Concurrency");
    const [r1] = w.rows.map((r) => r.rowId);

    const stale = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1])],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: 1, actual: 2 });

    const send = (label) => patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 2, stations: [station([r1], { label })],
    });
    const [one, two] = await Promise.all([send("First"), send("Second")]);
    expect([one, two].filter((r) => r.status === 200)).toHaveLength(1);
    const loser = [one, two].find((r) => r.status !== 200);
    expect(loser.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");

    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.revision).toBe(3);
    expect(stored.history.filter((e) => e.type === "LINE_LAYOUT_EDITED")).toHaveLength(2);
  });

  test("a save that changes nothing changes nothing", async () => {
    const { w, layout } = await balanced("NoOp");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: layout.stations.map((s) => ({
        stationId: s.stationId,
        label: `  ${s.label}  `,
        note: s.note,
        assignments: s.assignments.map((a) => ({ rowId: a.rowId })),
      })),
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.layout.metrics.totalWorkContentMinutes).toBe(4.5);

    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("a real change moves the revision once and records one bounded event", async () => {
    const { w, layout } = await balanced("RealChange");
    const before = await IeLineLayout.findById(layout.layoutId).lean();
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);

    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [
        { stationId: layout.stations[0].stationId, label: layout.stations[0].label, assignments: [{ rowId: r1 }] },
        { stationId: layout.stations[1].stationId, assignments: [{ rowId: r2 }, { rowId: r3 }, { rowId: r4 }] },
      ],
    });

    expect(res.body.updated).toBe(true);
    expect(res.body.layout.revision).toBe(before.revision + 1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].changed).toEqual(["assignments"]);
    expect(res.body.events[0].summary.length).toBeLessThanOrEqual(300);
    /* The audit line carries no stations. */
    expect(JSON.stringify(res.body.events)).not.toMatch(/stationId|rowId|standardTimeMinutes/);

    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.history).toHaveLength(before.history.length + 1);
    /* 1.0 against 3.5: the balance got worse, and says so. */
    expect(res.body.layout.metrics).toMatchObject({
      totalWorkContentMinutes: 4.5, bottleneckMinutes: 3.5, balanceEfficiencyPercent: 64.2857,
    });
  });

  test("nothing upstream is touched by opening or editing a layout", async () => {
    const w = await world("NoSideEffects");
    const fileBefore = await IeStyleFile.findById(w.fileId).lean();
    const opBefore = await IeOperation.findById(w.operations[0].operationId).lean();
    const studyBefore = await IeMethodStudy.findById(w.approvals[0].studyId).lean();

    const layout = (await open(w.maker, w)).body.layout;
    await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station(w.rows.map((r) => r.rowId))],
    });

    const fileAfter = await IeStyleFile.findById(w.fileId).lean();
    expect(fileAfter.revision).toBe(fileBefore.revision);
    expect(fileAfter.bulletin.rows).toEqual(fileBefore.bulletin.rows);
    expect(fileAfter.history).toHaveLength(fileBefore.history.length);

    const opAfter = await IeOperation.findById(w.operations[0].operationId).lean();
    expect(opAfter.revision).toBe(opBefore.revision);
    expect(opAfter.updatedAt.toISOString()).toBe(opBefore.updatedAt.toISOString());

    const studyAfter = await IeMethodStudy.findById(w.approvals[0].studyId).lean();
    expect(studyAfter.revision).toBe(studyBefore.revision);
    expect(studyAfter.status).toBe("APPROVED");
    expect(studyAfter.approved.standardTimeMinutes).toBe(studyBefore.approved.standardTimeMinutes);
    expect(studyAfter.updatedAt.toISOString()).toBe(studyBefore.updatedAt.toISOString());
  });

  test("there is no release, assignment or capacity verb", async () => {
    /* CHUNK 7C2 adds `/approve`, and only that. Everything downstream of an
       approved plan — releasing it, acknowledging it, assigning people to it,
       booking capacity against it — is still absent, so a shell built against
       this router cannot find a control for any of it. */
    const w = await world("NoDownstream");
    const layout = (await open(w.maker, w)).body.layout;
    for (const p of [
      `/line-layouts/${layout.layoutId}/submit`,
      `/line-layouts/${layout.layoutId}/release`,
      `/line-layouts/${layout.layoutId}/publish`,
      `/line-layouts/${layout.layoutId}/assign`,
      `/line-layouts/${layout.layoutId}/capacity`,
      `/line-layouts/${layout.layoutId}/acknowledge`,
    ]) {
      expect((await call(p, { method: "POST", token: w.approver.token, company: w.co._id, body: {} })).status).toBe(404);
    }
    /* The one verb that DOES exist answers as a route, not as a missing one. */
    const approve = await call(`/line-layouts/${layout.layoutId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id, body: {},
    });
    expect(approve.status).toBe(400);
    expect(approve.body.error.details.fieldErrors[0].field).toBe("expectedRevision");
    expect((await call(`/line-layouts/${layout.layoutId}`, {
      method: "DELETE", token: w.maker.token, company: w.co._id,
    })).status).toBe(404);

    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    /* CHUNK 7C2: `/approve` is the ONE verb this router gained for a layout.
       Every other downstream verb is still absent. */
    expect(paths.filter((p) => /line-layout/.test(p) && /approve/i.test(p)))
      .toEqual(["/line-layouts/:layoutId/approve"]);
    expect(paths.filter((p) => /line-layout/.test(p) && /submit|release|assign|acknowledge|publish|book/i.test(p)))
      .toEqual([]);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(paths.filter((p) => /release|apply|shift|target/i.test(p))
      .filter((p) => p !== "/style-files/:fileId/releases"
        && p !== "/releases/:releaseId/impact")).toEqual([]);
    /* ── THE ONE CAPACITY EXCEPTION, NAMED ────────────────────────────────
       Chunk 7A owns capacity standards and adds exactly two capacity routes
       under a layout — open one, and list this layout's. Neither is a verb this
       chunk's boundary excludes: there is still no approve, submit, release,
       assign, publish, book, allocate or acknowledge anywhere near a layout,
       and a capacity standard approves and books nothing. */
    expect(paths.filter((p) => /capacity/i.test(p)).sort()).toEqual([
      "/capacity-standards",
      "/capacity-standards/:capacityStandardId",
      "/capacity-standards/:capacityStandardId",
      /* CHUNK 7C3 added exactly one verb to a capacity standard: approving it.
         A standard is a target somebody accepts, and accepting it is a decision
         taken inside IE. */
      "/capacity-standards/:capacityStandardId/approve",
      "/line-layouts/:layoutId/capacity-standards",
      "/line-layouts/:layoutId/capacity-standards",
    ]);
    /* And nothing DOWNSTREAM of an accepted target, which is what this
       assertion has always been about. */
    expect(paths.filter((p) => /capacity/i.test(p)
      && /submit|release|publish|assign|book|allocate|acknowledge|scan|barcode/i.test(p))).toEqual([]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods))).not.toContain("delete");
    /* `canApprove` is now a real answer about this record. What stays false is
       everything downstream of an approved plan. */
    expect(layout.canApprove).toBe(true);
    expect(layout.canRelease).toBe(false);
    expect(layout.allocates).toBe(false);
  });
});

/* ══ 4. THE ARITHMETIC ON ITS OWN ═════════════════════════════════════════ */

describe("line balance, without a server", () => {
  const st = (...minutes) => ({ stationId: `s${minutes.join("")}`, assignments: minutes.map((m) => ({ standardTimeMinutes: m })) });

  test("the canonical formulas", () => {
    const out = calculateLineBalance([st(1, 1.2), st(0.8, 1.5)]);
    expect(out).toMatchObject({
      totalWorkContentMinutes: 4.5,
      stationCount: 2,
      pitchMinutes: 2.25,
      bottleneckMinutes: 2.3,
      balanceEfficiencyPercent: 97.8261,
      balanceLossPercent: 2.1739,
      metricsAvailable: true,
    });
    /* Efficiency and loss always add to 100 — both come from one rounding. */
    expect(out.balanceEfficiencyPercent + out.balanceLossPercent).toBe(100);
  });

  test("an empty station is in the divisor", () => {
    expect(calculateLineBalance([st(1, 1.2), st(0.8, 1.5), st()]))
      .toMatchObject({ stationCount: 3, pitchMinutes: 1.5, balanceEfficiencyPercent: 65.2174 });
  });

  test("a zero denominator is null, never NaN, Infinity or 0%", () => {
    for (const stations of [[], [st()], [st(), st()]]) {
      const out = calculateLineBalance(stations);
      expect(out.balanceEfficiencyPercent).toBeNull();
      expect(out.balanceLossPercent).toBeNull();
      expect(out.metricsAvailable).toBe(false);
      expect(Number.isNaN(out.balanceEfficiencyPercent)).toBe(false);
    }
    expect(calculateLineBalance([]).metricsUnavailableReason).toBe("NO_STATIONS");
    expect(calculateLineBalance([st()]).metricsUnavailableReason).toBe("NO_WORK_ASSIGNED");
    expect(calculateLineBalance([]).pitchMinutes).toBeNull();
  });

  test("the arithmetic is decimal-safe and order-independent", () => {
    /* 0.1 + 0.2 is not 0.3 in a double; scaled integers make it 0.3. */
    expect(calculateLineBalance([st(0.1, 0.2)]).totalWorkContentMinutes).toBe(0.3);
    const a = calculateLineBalance([st(0.1, 0.2, 0.3), st(1.15)]);
    const b = calculateLineBalance([st(0.3, 0.2, 0.1), st(1.15)]);
    expect(a.totalWorkContentMinutes).toBe(b.totalWorkContentMinutes);
    expect(a.balanceEfficiencyPercent).toBe(b.balanceEfficiencyPercent);
    /* One rounding policy: half-up to four decimals, at the boundary only. */
    for (const v of [a.totalWorkContentMinutes, a.pitchMinutes, a.bottleneckMinutes, a.balanceEfficiencyPercent]) {
      expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });

  test("station workloads name the bottleneck and the idle time against it", () => {
    const out = calculateLineBalance([st(1, 1.2), st(0.8, 1.5)]);
    expect(out.stationWorkloads.map((s) => [s.workloadMinutes, s.idleMinutes, s.isBottleneck]))
      .toEqual([[2.2, 0.1, false], [2.3, 0, true]]);
  });
});

/* ══ 5. THE SOURCE IS THE REVISION AND THE APPROVAL ═══════════════════════
 *
 * Two review blockers, both about what "the same source" means:
 *
 *   · comparing row identities instead of the bulletin REVISION left a
 *     note-only or proposed-SAM edit looking CURRENT, so somebody kept editing
 *     a layout the bulletin had moved out from under;
 *   · keying the layout on the revision alone made a LATER approval invisible —
 *     the open endpoint returned the layout built from the old approval and the
 *     index refused a new one, so a line could never be re-balanced against a
 *     standard just approved. */

/* ══ 5. WHAT A VERSION-BACKED LAYOUT IS JUDGED AGAINST (CHUNK 7C2) ════════
 *
 * REWRITTEN. Until 7C1 a layout was balanced against the Style File's embedded
 * bulletin, which is a working draft — so a note-only edit, a re-proposed SAM
 * or a newly approved method study each moved the source out from under it, and
 * the block this replaces proved exactly that.
 *
 * A layout is now opened against an IMMUTABLE approved bulletin version, and is
 * judged against that version and nothing else. Every one of those edits still
 * happens, to the SUCCESSOR draft, and none of them touches a layout balanced
 * against a version somebody approved. That is the point: a plan stops being
 * quietly restated by whoever last typed in the bulletin.
 *
 * What supersedes a layout now is a NEW approved version, which is a decision
 * two people took rather than an edit one person made.
 */

describe("a version-backed layout is judged against its own bulletin version", () => {
  async function balanced(name) {
    const w = await world(name);
    const layout = (await open(w.maker, w)).body.layout;
    const [r1, r2, r3, r4] = w.rows.map((r) => r.rowId);
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1, r2]), station([r3, r4])],
    });
    expect(saved.status).toBe(200);
    return { w, layout: saved.body.layout };
  }
  const rowsFor = (w, mutate = (r) => r) => w.rows.map((r, i) => mutate({
    rowId: r.rowId, ieOperationId: r.ieOperationId, proposedSamMinutes: r.proposedSamMinutes,
  }, i));
  const saveBulletin = (w, rows, expectedRevision) => call(`/engineering-files/${w.fileId}/bulletin`, {
    method: "PATCH", token: w.maker.token, company: w.co._id,
    body: { expectedRevision, rows },
  });

  test("it names the exact approved version it balances", async () => {
    const { w, layout } = await balanced("Bound");
    expect(layout.versionBacked).toBe(true);
    expect(layout.bulletinVersion).toMatchObject({
      bulletinVersionId: w.bulletinVersion.bulletinVersionId,
      versionNo: 1,
      state: "APPROVED",
    });
    /* And `bulletinRevision` keeps exactly its old meaning: the file revision
       the rows were taken from, which the version itself recorded. */
    expect(layout.source.bulletinRevision).toBe(w.bulletinVersion.fileRevisionAtSubmit);
    expect(layout.source.fingerprint).toBe(w.bulletinVersion.source.fingerprint);

    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(String(stored.ieBulletinVersionId)).toBe(w.bulletinVersion.bulletinVersionId);
    expect(stored.bulletinVersionNo).toBe(1);
  });

  test("editing the successor draft does not touch it", async () => {
    /* A note-only edit, a re-proposed SAM and a removed row — every edit that
       used to make a layout stale. The draft being edited is the SUCCESSOR, and
       the layout is a balance of the version, so it stays current. */
    const { w, layout } = await balanced("SuccessorEdits");
    const before = await IeLineLayout.findById(layout.layoutId).lean();
    let revision = w.fileRevisionNow;

    for (const rows of [
      rowsFor(w, (r, i) => (i === 0 ? { ...r, note: "A note nobody balanced against" } : r)),
      rowsFor(w, (r, i) => (i === 1 ? { ...r, proposedSamMinutes: 9 } : r)),
      rowsFor(w).slice(0, 3),
    ]) {
      const edited = await saveBulletin(w, rows, revision);
      expect(edited.status).toBe(200);
      revision = edited.body.file.revision;

      const after = await readLayout(w.maker, w, layout.layoutId);
      expect(after.body.layout.source.state).toBe("CURRENT");
      expect(after.body.layout.editable).toBe(true);
      expect(after.body.layout.readiness.gaps.map((g) => g.code))
        .not.toContain("IE_LAYOUT_SOURCE_CHANGED");
    }

    /* Not one stored byte moved, and it is still editable as a plan. */
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.sourceRows).toEqual(before.sourceRows);
    expect(stored.stations).toEqual(before.stations);
    expect(stored.revision).toBe(before.revision);

    const stillEdits = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: stored.revision,
      stations: [station(w.rows.map((r) => r.rowId))],
    });
    expect(stillEdits.status).toBe(200);
  });

  test("a newer approved method study does not restate it either", async () => {
    /* Chunk 4B permits a row to be re-timed and approved again. That moves the
       SUCCESSOR draft's current source; it does not move a version. */
    const { w, layout } = await balanced("LaterApproval");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    await approveAgain(w, 0, { minutes: 4.25 });

    const after = await readLayout(w.maker, w, layout.layoutId);
    expect(after.body.layout.source.state).toBe("CURRENT");
    expect(after.body.layout.source.rows[0].standardTimeMinutes).toBe(1);
    expect(after.body.layout.metrics.totalWorkContentMinutes).toBe(4.5);
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.sourceRows).toEqual(before.sourceRows);
  });

  test("a NEW approved version is what produces a new layout", async () => {
    const { w, layout } = await balanced("NewVersion");

    /* Re-time a row, then submit and approve the successor as version 2. */
    await approveAgain(w, 0, { minutes: 4.25 });
    const second = await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
    });
    expect(second.version.versionNo).toBe(2);

    /* Opening now gives a layout for version 2, beside the one for version 1. */
    const fresh = await open(w.maker, w);
    expect(fresh.status).toBe(201);
    expect(fresh.body.layout.layoutId).not.toBe(layout.layoutId);
    expect(fresh.body.layout.bulletinVersion.versionNo).toBe(2);
    expect(fresh.body.layout.source.rows[0].standardTimeMinutes).toBe(4.25);

    /* The first is kept, still a balance of version 1, and still says so. */
    const older = await readLayout(w.maker, w, layout.layoutId);
    expect(older.body.layout.bulletinVersion.versionNo).toBe(1);
    expect(older.body.layout.source.rows[0].standardTimeMinutes).toBe(1);
    expect(await IeLineLayout.countDocuments({
      ieStyleFileId: new mongoose.Types.ObjectId(w.fileId),
    })).toBe(2);
  });

  test("opening twice against one approved version resumes the same draft", async () => {
    const w = await world("ResumeOne");
    const first = await open(w.maker, w);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const again = await open(w.maker, w);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.layout.layoutId).toBe(first.body.layout.layoutId);
    expect(await IeLineLayout.countDocuments({
      ieStyleFileId: new mongoose.Types.ObjectId(w.fileId),
    })).toBe(1);

    /* Even after it has been arranged. */
    const saved = await patchLayout(w.maker, w, first.body.layout.layoutId, {
      expectedRevision: 1, stations: [station(w.rows.map((r) => r.rowId))],
    });
    expect(saved.status).toBe(200);
    const third = await open(w.maker, w);
    expect(third.body.created).toBe(false);
    expect(third.body.layout.stations).toHaveLength(1);
  });

  test("a stale revision is refused, and two simultaneous edits leave one winner", async () => {
    const { w, layout } = await balanced("Concurrency");
    const [r1] = w.rows.map((r) => r.rowId);

    const stale = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [station([r1])],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: 1, actual: 2 });

    const [one, two] = await Promise.all([
      patchLayout(w.maker, w, layout.layoutId, {
        expectedRevision: 2, stations: [station(w.rows.slice(0, 2).map((r) => r.rowId))],
      }),
      patchLayout(w.maker, w, layout.layoutId, {
        expectedRevision: 2, stations: [station(w.rows.slice(2).map((r) => r.rowId))],
      }),
    ]);
    const winners = [one, two].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).revision).toBe(3);
  });

  test("company isolation survives the version identity", async () => {
    const theirs = await world("TheirVersion");
    const theirLayout = (await open(theirs.maker, theirs)).body.layout;
    const mine = await world("MyVersion");

    const foreign = await readLayout(mine.maker, mine, theirLayout.layoutId);
    const invented = await readLayout(mine.maker, mine, new mongoose.Types.ObjectId());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(invented.body);
    expect(JSON.stringify(foreign.body)).not.toContain(theirLayout.bulletinVersion.bulletinVersionId);

    const mineLayout = (await open(mine.maker, mine)).body.layout;
    expect(mineLayout.layoutId).not.toBe(theirLayout.layoutId);
    expect(mineLayout.bulletinVersion.bulletinVersionId)
      .not.toBe(theirLayout.bulletinVersion.bulletinVersionId);
  });
});

/* ══ 6. THE FINGERPRINT ON ITS OWN ════════════════════════════════════════ */

describe("the source fingerprint", () => {
  const { sourceFingerprintOf, laterApproval } = require("../../services/industrialEngineering/ieLineLayout.service");
  const row = (over = {}) => ({
    rowId: "row_a", ieOperationId: "6aa0000000000000000000a1", ieOperationRevision: 1,
    methodStudyId: "6aa0000000000000000000b1", approvedSubmissionId: "sub_1",
    standardTimeMinutes: 1.5, ...over,
  });

  test("the same source hashes the same, every time", () => {
    expect(sourceFingerprintOf([row()])).toBe(sourceFingerprintOf([row()]));
    expect(sourceFingerprintOf([row()])).toMatch(/^[0-9a-f]{64}$/);
    /* 1.5 and 1.5000 are one number, not two sources. */
    expect(sourceFingerprintOf([row({ standardTimeMinutes: 1.5 })]))
      .toBe(sourceFingerprintOf([row({ standardTimeMinutes: 1.5000 })]));
  });

  test("every part of the evidence changes it", () => {
    const base = sourceFingerprintOf([row()]);
    for (const over of [
      { rowId: "row_b" },
      { ieOperationId: "6aa0000000000000000000a2" },
      { ieOperationRevision: 2 },
      { methodStudyId: "6aa0000000000000000000b2" },
      { approvedSubmissionId: "sub_2" },
      { standardTimeMinutes: 1.6 },
    ]) {
      expect(sourceFingerprintOf([row(over)])).not.toBe(base);
    }
    /* Order is part of the source: the same rows in another sequence are a
       different line. */
    expect(sourceFingerprintOf([row(), row({ rowId: "row_b" })]))
      .not.toBe(sourceFingerprintOf([row({ rowId: "row_b" }), row()]));
  });

  test("the later approval is chosen by time, then by id", () => {
    const at = (t, id) => ({ _id: id, approved: { at: new Date(t) } });
    expect(laterApproval(at("2026-09-01", "a"), at("2026-09-02", "b"))._id).toBe("b");
    expect(laterApproval(at("2026-09-02", "a"), at("2026-09-01", "b"))._id).toBe("a");
    /* Same instant: the larger id, deterministically, both ways round. */
    expect(laterApproval(at("2026-09-01", "aaa"), at("2026-09-01", "bbb"))._id).toBe("bbb");
    expect(laterApproval(at("2026-09-01", "bbb"), at("2026-09-01", "aaa"))._id).toBe("bbb");
    expect(laterApproval(null, at("2026-09-01", "a"))._id).toBe("a");
  });
});
