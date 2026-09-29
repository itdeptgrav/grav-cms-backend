// test/industrial-engineering/ppc-ie-release-receipt.route.test.js
//
// IE CHUNK 8A-ii — PPC RECEIVES AN ISSUED RELEASE, AND ANSWERS IT ONCE.
//
// The claims worth holding:
//
//   · the queue IS a query over IE's immutable releases — no outbox, no
//     delivery row, no copy inside PPC, and nothing to reconcile;
//   · `PENDING` is computed from the absence of a receipt, and every derived
//     state names BOTH halves (what PPC said, and what happened to the release
//     it said it about);
//   · the views filter BEFORE they paginate, so no release is ever skipped by
//     a page it did not appear on;
//   · the detail read is an allowlist — the frozen handover, and none of IE's
//     workspace;
//   · one release version is answered exactly once, by one immutable row, by
//     the authenticated person, with no reject and no route that could add one;
//   · a retry replays, a reused key is refused, a second answer is refused, and
//     two simultaneous answers produce ONE row and no duplicate-key error;
//   · and answering changes nothing in `ie_releases`.
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
const {
  IeReleaseReceipt, RECEIPT_STATE, CLARIFICATION_CATEGORY,
} = require("../../models/CMS_Models/PPC/IeReleaseReceipt");

let server, ieBase, ppcBase, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/ieReleasesRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  const root = `http://127.0.0.1:${server.address().port}/api/cms`;
  ieBase = `${root}/ie`;
  ppcBase = `${root}/ppc`;
  await IeStyleFile.syncIndexes();
  await IeRelease.syncIndexes();
  await IeReleaseReceipt.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const at = (base) => (p, { method = "GET", body, token, company, key } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      /* Header only — never a body field. */
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

const call = (p, o) => at(ieBase)(p, o);
const ppc = (p, o) => at(ppcBase)(p, o);

let keySeq = 0;
const nextKey = () => `ppc-key-${++keySeq}-${Date.now()}`;

/* ══ ACTORS ═══════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `ack${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `A${n}`, email, biometricId: `ACK${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "A",
    });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  const name = `Person ${n}`;
  return {
    email,
    name,
    employeeId: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* ══ A REAL, RELEASABLE WORLD ═════════════════════════════════════════════
   Copied from `ie-release.route.test.js`: a style file whose bulletin version,
   line layout and capacity standard are all approved, which is the only shape a
   release can be issued from. PPC's own people are granted separately, because
   an IE grant reaches none of PPC's verbs and a PPC grant reaches none of IE's. */

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

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  return co;
}

async function world(name, co) {
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

  const maker = await actor({ companies: [co], grants: { ie: "editor" } });
  const approver = await actor({ companies: [co], grants: { ie: "approver" } });
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

  const minutes = [1, 1.2, 0.8, 1.5];
  const operations = [];
  for (let i = 0; i < minutes.length; i += 1) {
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

  return { co, maker, approver, fileId: file.fileId, rows };
}

/** A layout arranged, approved, and a capacity standard approved against it. */
async function approvedAggregate(w, {
  plannedOperatorCount = INPUTS.plannedOperatorCount,
  /* Chunk 7B: WHICH ramp stage this standard is planned for, chosen explicitly.
     Omitted by default — most of this suite has no reason to carry one — and
     supplied by the connected journey, because "the approved ramp assumption"
     is one of the five things a release is required to hand over. */
  ramp = null,
} = {}) {
  const t = { token: w.maker.token, company: w.co._id };
  const opened = await call(`/engineering-files/${w.fileId}/line-layouts`, {
    method: "POST", ...t, body: {},
  });
  expect(opened.status).toBe(201);
  const draft = opened.body.layout;
  const layoutRows = draft.source.rows;
  const saved = await call(`/line-layouts/${draft.layoutId}`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: draft.revision,
      stations: [
        {
          label: "Front", note: "Two operators",
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }],
          assignments: [{ rowId: layoutRows[0].rowId }, { rowId: layoutRows[1].rowId }],
        },
        {
          label: "Close", note: "",
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }],
          assignments: [{ rowId: layoutRows[2].rowId }, { rowId: layoutRows[3].rowId }],
        },
      ],
    },
  });
  expect(saved.status).toBe(200);
  const approvedLayout = await call(`/line-layouts/${draft.layoutId}/approve`, {
    method: "POST", token: w.approver.token, company: w.co._id,
    body: { expectedRevision: saved.body.layout.revision },
  });
  expect(approvedLayout.status).toBe(200);
  const layout = approvedLayout.body.layout;

  const made = await call(`/line-layouts/${layout.layoutId}/capacity-standards`, {
    method: "POST", ...t, body: { ...INPUTS, plannedOperatorCount, ...(ramp || {}) },
  });
  expect(made.status).toBe(201);
  const approvedStd = await call(
    `/capacity-standards/${made.body.standard.capacityStandardId}/approve`,
    {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: made.body.standard.revision },
    },
  );
  expect(approvedStd.status).toBe(200);

  const version = await IeBulletinVersion.findOne({
    companyId: w.co._id, ieStyleFileId: w.fileId, state: "APPROVED",
  }).lean();
  return {
    layout,
    standard: approvedStd.body.standard,
    body: {
      bulletinVersionId: String(version._id),
      expectedBulletinVersionNo: version.versionNo,
      lineLayoutId: layout.layoutId,
      expectedLayoutRevision: layout.revision,
      capacityStandardId: approvedStd.body.standard.capacityStandardId,
      expectedCapacityRevision: approvedStd.body.standard.revision,
    },
  };
}

const issue = (w, body) => call(`/style-files/${w.fileId}/releases`, {
  method: "POST", token: w.approver.token, company: w.co._id, body, key: nextKey(),
});

/** A company with PPC people and one issued release. */
async function issued(name, aggregateOptions = undefined) {
  const co = await company(name);
  const w = await world(name, co);
  /* A function, when the options need the world that is only just built — a
     ramp profile belongs to a company, so it cannot be written in advance. */
  const options = typeof aggregateOptions === "function"
    ? await aggregateOptions(w)
    : aggregateOptions;
  const agg = await approvedAggregate(w, options);
  const res = await issue(w, agg.body);
  expect(res.status).toBe(201);
  return {
    co,
    w,
    agg,
    release: res.body.release,
    viewer: await actor({ companies: [co], grants: { ppc: "viewer" } }),
    approver: await actor({ companies: [co], grants: { ppc: "approver" } }),
  };
}

/**
 * An active ramp profile of three stages, created through IE's own route, and
 * the stage a capacity standard should be planned for.
 *
 * Stage two — days 4 to 10 at 60% — rather than the first: a release that froze
 * the opening stage could be right by accident, and the ramp is the field most
 * easily mistaken for the steady-state target.
 */
async function rampStage(w) {
  const made = await call("/ramp-profiles", {
    method: "POST", token: w.maker.token, company: w.co._id,
    body: {
      name: `Ramp ${++seq}`,
      description: "As agreed with the floor",
      stages: [
        { label: "Week one", fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 40 },
        { label: "Settling", fromProductionDay: 4, toProductionDay: 10, targetEfficiencyPercent: 60 },
        { label: "Steady", fromProductionDay: 11, toProductionDay: null, targetEfficiencyPercent: 80 },
      ],
    },
  });
  expect(made.status).toBe(201);
  const stage = made.body.profile.stages[1];
  return {
    profile: made.body.profile,
    stage,
    ramp: { rampProfileId: made.body.profile.rampProfileId, rampStageId: stage.stageId },
  };
}

/** Issue a successor version, which supersedes the one before it. */
async function issueSuccessor(ctx, plannedOperatorCount) {
  const t = { token: ctx.w.maker.token, company: ctx.co._id };
  const made = await call(`/line-layouts/${ctx.agg.layout.layoutId}/capacity-standards`, {
    method: "POST", ...t, body: { ...INPUTS, plannedOperatorCount },
  });
  expect(made.status).toBe(201);
  const approvedStd = await call(
    `/capacity-standards/${made.body.standard.capacityStandardId}/approve`,
    {
      method: "POST", token: ctx.w.approver.token, company: ctx.co._id,
      body: { expectedRevision: made.body.standard.revision },
    },
  );
  expect(approvedStd.status).toBe(200);
  const res = await issue(ctx.w, {
    ...ctx.agg.body,
    capacityStandardId: approvedStd.body.standard.capacityStandardId,
    expectedCapacityRevision: approvedStd.body.standard.revision,
  });
  expect(res.status).toBe(201);
  return res.body.release;
}

/* ── FABRICATED RELEASES ──────────────────────────────────────────────────
   The queue is a query over `ie_releases`, so the queue's own claims — the
   views, the derived states and the page arithmetic — are proved against
   releases written straight into the collection. Cheaper than twenty full
   engineering chains, and it exercises exactly the code under test. Every
   DECISION test above and below runs against a genuinely issued release. */
async function fabricate(co, { versionNo = 1, ref, state = "ISSUED", issuedAt, fileId, rows = [] } = {}) {
  const n = ++seq;
  return IeRelease.create({
    companyId: co._id,
    releaseRef: ref || `IEREL-FAB${String(n).padStart(6, "0")}`,
    versionNo,
    ieStyleFileId: fileId || new mongoose.Types.ObjectId(),
    sampleStyleId: new mongoose.Types.ObjectId(),
    state,
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(),
      bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"),
      rows,
      garmentSamMinutes: 4.5,
      samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: {
        inputs: { plannedOperatorCount: 25 },
        calculation: { targetPiecesPerDay: 100 },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
      },
      capturedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    issuedBy: new mongoose.Types.ObjectId(),
    issuedByName: "Fabricator",
    issuedAt: issuedAt || new Date("2026-09-01T00:00:00.000Z"),
  });
}

const stateOf = async (co, releaseId, person) => {
  const res = await ppc(`/ie-releases/${releaseId}`, { token: person.token, company: co._id });
  expect(res.status).toBe(200);
  return res.body.release.effectiveState;
};

/* ══ 1. COMPANY ═══════════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("another company's release is invisible, unreadable and undecidable", async () => {
    const mine = await issued("Mine");
    const theirs = await issued("Theirs");

    const queue = await ppc("/ie-releases?view=all", {
      token: mine.viewer.token, company: mine.co._id,
    });
    expect(queue.status).toBe(200);
    expect(queue.body.rows.map((r) => r.releaseId)).toEqual([mine.release.releaseId]);

    /* A foreign id and an id that never existed are ONE answer. */
    const foreign = await ppc(`/ie-releases/${theirs.release.releaseId}`, {
      token: mine.viewer.token, company: mine.co._id,
    });
    const absent = await ppc(`/ie-releases/${new mongoose.Types.ObjectId()}`, {
      token: mine.viewer.token, company: mine.co._id,
    });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
    expect(foreign.body).toEqual(absent.body);

    const decided = await ppc(`/ie-releases/${theirs.release.releaseId}/accept`, {
      method: "POST", token: mine.approver.token, company: mine.co._id, body: {}, key: nextKey(),
    });
    expect(decided.status).toBe(404);
    expect(decided.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);
  });

  test("a malformed id is the typed not-found, never a cast error", async () => {
    const ctx = await issued("Malformed");
    for (const bad of ["not-an-id", "12345", "0123456789", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const read = await ppc(`/ie-releases/${bad}`, {
        token: ctx.viewer.token, company: ctx.co._id,
      });
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
      const decided = await ppc(`/ie-releases/${bad}/accept`, {
        method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
      });
      expect(decided.status).toBe(404);
      expect(decided.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
    }
  });
});

/* ══ 2. AUTHORITY ═════════════════════════════════════════════════════════ */

describe("who may read and who may answer", () => {
  test("a PPC viewer reads but cannot answer; a PPC approver can", async () => {
    const ctx = await issued("Roles");

    const read = await ppc("/ie-releases", { token: ctx.viewer.token, company: ctx.co._id });
    expect(read.status).toBe(200);

    const refused = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.viewer.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN");

    const allowed = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(allowed.status).toBe(200);
  });

  test("an IE grant of any level reaches neither the queue nor the decision", async () => {
    const ctx = await issued("IeCannotAck");
    /* The very people who built and issued this release. */
    for (const person of [ctx.w.maker, ctx.w.approver]) {
      const read = await ppc("/ie-releases", { token: person.token, company: ctx.co._id });
      expect(read.status).toBe(403);

      const decided = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
        method: "POST", token: person.token, company: ctx.co._id, body: {}, key: nextKey(),
      });
      expect(decided.status).toBe(403);
      expect(decided.body.error.code).toBe("IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN");
    }
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);
  });
});

/* ══ 3. THE QUEUE ═════════════════════════════════════════════════════════ */

describe("the queue and its derived states", () => {
  test("all three views, and every one of the seven effective states", async () => {
    const co = await company("States");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const person = await actor({ companies: [co], grants: { ppc: "approver" } });
    const seen = {};

    /* ISSUED, no receipt. */
    const pendingRelease = await fabricate(co, { issuedAt: new Date("2026-09-07T00:00:00Z") });
    seen.PENDING = pendingRelease;

    /* ISSUED + each decision. */
    const acceptedRelease = await fabricate(co, { issuedAt: new Date("2026-09-06T00:00:00Z") });
    expect((await ppc(`/ie-releases/${acceptedRelease._id}/accept`, {
      method: "POST", token: person.token, company: co._id, body: {}, key: nextKey(),
    })).status).toBe(200);
    seen.ACCEPTED = acceptedRelease;

    const clarifiedRelease = await fabricate(co, { issuedAt: new Date("2026-09-05T00:00:00Z") });
    expect((await ppc(`/ie-releases/${clarifiedRelease._id}/clarify`, {
      method: "POST", token: person.token, company: co._id, key: nextKey(),
      body: { category: "LINE_LAYOUT", reason: "The close station has no overlock planned." },
    })).status).toBe(200);
    seen.CLARIFICATION_REQUESTED = clarifiedRelease;

    /* SUPERSEDED, with and without a receipt. Decided FIRST, then superseded —
       which is the only order a real release could reach these states in. */
    const undecided = await fabricate(co, {
      state: "SUPERSEDED", issuedAt: new Date("2026-09-04T00:00:00Z"),
    });
    seen.SUPERSEDED_UNDECIDED = undecided;

    const acceptedThenSuperseded = await fabricate(co, {
      issuedAt: new Date("2026-09-03T00:00:00Z"),
    });
    expect((await ppc(`/ie-releases/${acceptedThenSuperseded._id}/accept`, {
      method: "POST", token: person.token, company: co._id, body: {}, key: nextKey(),
    })).status).toBe(200);
    const clarifiedThenSuperseded = await fabricate(co, {
      issuedAt: new Date("2026-09-02T00:00:00Z"),
    });
    expect((await ppc(`/ie-releases/${clarifiedThenSuperseded._id}/clarify`, {
      method: "POST", token: person.token, company: co._id, key: nextKey(),
      body: { category: "CAPACITY_STANDARD", reason: "That operator count is not staffed yet." },
    })).status).toBe(200);
    /* Superseding is IE's own conditional move; the raw write stands in for it
       here because this suite must not drive an IE verb. */
    await mongoose.connection.collection("ie_releases").updateMany(
      { _id: { $in: [acceptedThenSuperseded._id, clarifiedThenSuperseded._id] } },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } },
    );
    seen.ACCEPTED_SUPERSEDED = acceptedThenSuperseded;
    seen.CLARIFICATION_REQUESTED_SUPERSEDED = clarifiedThenSuperseded;

    /* WITHDRAWN — no route reaches it, so the state is fabricated directly. */
    const withdrawn = await fabricate(co, { issuedAt: new Date("2026-09-01T00:00:00Z") });
    await mongoose.connection.collection("ie_releases")
      .updateOne({ _id: withdrawn._id }, { $set: { state: "WITHDRAWN" } });
    seen.WITHDRAWN = withdrawn;

    for (const [expected, doc] of Object.entries(seen)) {
      expect(await stateOf(co, doc._id, viewer)).toBe(expected);
    }

    const byView = async (view) => {
      const res = await ppc(`/ie-releases?view=${view}&limit=100`, {
        token: viewer.token, company: co._id,
      });
      expect(res.status).toBe(200);
      expect(res.body.view).toBe(view);
      return new Map(res.body.rows.map((r) => [r.releaseId, r.effectiveState]));
    };

    /* PENDING is the absence of a receipt — and a superseded release, decided
       or not, is never offered as work. */
    const pending = await byView("pending");
    expect([...pending.keys()]).toEqual([String(pendingRelease._id)]);
    expect(pending.get(String(pendingRelease._id))).toBe("PENDING");

    const decided = await byView("decided");
    expect(new Set(decided.keys())).toEqual(new Set([
      String(acceptedRelease._id), String(clarifiedRelease._id),
      String(acceptedThenSuperseded._id), String(clarifiedThenSuperseded._id),
    ]));

    /* `all` covers ISSUED and SUPERSEDED. A withdrawn release was never handed
       over and is not in anybody's queue — it still reads, and reads WITHDRAWN. */
    const all = await byView("all");
    expect(all.has(String(withdrawn._id))).toBe(false);
    expect(all.size).toBe(6);
    expect(all.get(String(undecided._id))).toBe("SUPERSEDED_UNDECIDED");
    expect(all.get(String(acceptedThenSuperseded._id))).toBe("ACCEPTED_SUPERSEDED");
    expect(all.get(String(clarifiedThenSuperseded._id))).toBe("CLARIFICATION_REQUESTED_SUPERSEDED");

    /* Newest first, by the instant IE issued it. */
    const order = (await ppc("/ie-releases?view=all&limit=100", {
      token: viewer.token, company: co._id,
    })).body.rows.map((r) => r.issuedAt);
    expect([...order]).toEqual([...order].sort().reverse());
  });

  test("the views filter BEFORE they paginate — no holes and no duplicates", async () => {
    const co = await company("Paging");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const person = await actor({ companies: [co], grants: { ppc: "approver" } });

    /* Twelve releases, every other one answered, and SIX of them sharing one
       instant — so a cursor that carried only a timestamp, or only an id, would
       lose or repeat rows here. */
    const made = [];
    for (let i = 0; i < 12; i += 1) {
      made.push(await fabricate(co, {
        issuedAt: new Date(i < 6 ? "2026-09-10T00:00:00Z" : `2026-09-${11 + i}T00:00:00Z`),
      }));
    }
    const answered = made.filter((_, i) => i % 2 === 0);
    for (const r of answered) {
      expect((await ppc(`/ie-releases/${r._id}/accept`, {
        method: "POST", token: person.token, company: co._id, body: {}, key: nextKey(),
      })).status).toBe(200);
    }

    const pageThrough = async (view) => {
      const ids = [];
      let cursor = null;
      let guard = 0;
      do {
        const res = await ppc(
          `/ie-releases?view=${view}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { token: viewer.token, company: co._id },
        );
        expect(res.status).toBe(200);
        /* Every page except the last is FULL. A page short of its limit while
           more rows remain is the signature of filtering after paginating. */
        if (res.body.hasMore) expect(res.body.rows).toHaveLength(2);
        ids.push(...res.body.rows.map((r) => r.releaseId));
        cursor = res.body.nextCursor;
        guard += 1;
      } while (cursor && guard < 30);
      return ids;
    };

    const pending = await pageThrough("pending");
    const decided = await pageThrough("decided");
    const all = await pageThrough("all");

    const expectedPending = made.filter((_, i) => i % 2 === 1).map((r) => String(r._id));
    expect(new Set(pending)).toEqual(new Set(expectedPending));
    expect(pending).toHaveLength(6);
    expect(new Set(pending).size).toBe(6);

    expect(new Set(decided)).toEqual(new Set(answered.map((r) => String(r._id))));
    expect(decided).toHaveLength(6);
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);

    const bad = await ppc("/ie-releases?cursor=not-a-cursor", {
      token: viewer.token, company: co._id,
    });
    expect(bad.status).toBe(400);
  });
});

/* ══ 4. THE DETAIL PROJECTION ═════════════════════════════════════════════ */

describe("what PPC is shown of a release", () => {
  test("the handover is complete, and IE's workspace is absent recursively", async () => {
    const ctx = await issued("Detail");
    const res = await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(res.status).toBe(200);
    const r = res.body.release;

    /* ── WHAT MUST BE THERE ──────────────────────────────────────────── */
    expect(r.releaseRef).toMatch(/^IEREL-[0-9A-F]{10}$/);
    expect(r.versionNo).toBe(1);
    /* ── NO SERVER INTEGRITY HASHES, ANYWHERE IN THE ENVELOPE ─────────
       They remain on the stored release — proved below — and remain IE's
       deduplication mechanism. They are not an operational fact PPC acts on. */
    expect(r.aggregateFingerprint).toBeUndefined();
    expect(r.bulletin.sourceFingerprint).toBeUndefined();
    expect(r.releaseState).toBe("ISSUED");
    expect(r.effectiveState).toBe("PENDING");
    expect(r.decidable).toBe(true);
    expect(r.bulletin.rows).toHaveLength(4);
    expect(r.bulletin.garmentSamMinutes).toBeCloseTo(4.5, 6);
    expect(r.bulletin.rows[0].standardTimeMinutes).toBeGreaterThan(0);
    /* Stable identity, not a display label. */
    expect(r.bulletin.rows[0].ieOperationId).toMatch(/^[0-9a-f]{24}$/);
    expect(r.bulletin.rows[0].ieOperationRevision).toBeGreaterThanOrEqual(1);
    /* And the frozen requirement evidence, carrying the moment and the revision
       it is evidence OF. */
    expect(r.bulletin.rows[0].requirementSnapshot).toEqual({
      capturedAt: expect.stringMatching(/^\d{4}-/),
      ieOperationRevision: expect.any(Number),
      requirementsConfigured: true,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
    });
    expect(r.lineLayout.stations).toHaveLength(2);
    expect(r.lineLayout.metrics.balanceEfficiencyPercent).toBeGreaterThan(0);
    expect(r.capacity.inputs.plannedOperatorCount).toBe(INPUTS.plannedOperatorCount);
    expect(r.capacity.calculation.wholePieceDailyTarget).toBeGreaterThan(0);
    expect(r.capacity.calculation.available).toBe(true);
    /* The whole calendar limitation, verbatim — a handover must never be the
       place a provisional standard is quietly upgraded. */
    expect(r.workingTime.calendarLinkage.state).toBe("UNKNOWN");
    expect(r.workingTime.calendarLinkage.reason).toBe("NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR");
    expect(r.workingTime.calendarLinkage.rejectedSources.length).toBeGreaterThan(0);
    expect(r.workingTime.calendarLinkage.requiredUpstreamContract).toBeTruthy();
    expect(r.readiness.state).toBe("PROVISIONAL");
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_WORKING_TIME_ASSUMED");
    expect(r.readiness.gaps[0]).toEqual(expect.objectContaining({
      code: expect.any(String), owner: expect.any(String),
      action: expect.any(String), message: expect.any(String),
    }));
    expect(r.booksCapacity).toBe(false);
    expect(r.writesProduction).toBe(false);

    /* ── AND WHAT MUST NOT ───────────────────────────────────────────── */
    const keys = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) { keys.push(k); walk(v); }
    };
    walk(r);
    const forbidden = [
      /* IE working records and internal handles. */
      "methodStudyId", "methodStudies", "observations", "cycles", "ratingPercent",
      "approvedSubmissionId", "proposedSamMinutes", "bulletinVersionId",
      "lineLayoutId", "capacityStandardId", "ieStyleFileId", "draft", "history",
      "allowancePolicyId", "allowances", "allowanceBreakdown", "allowancePercent",
      /* Somebody else's department entirely. */
      "sampleStyleId", "enquiryId", "journeyId", "accountId", "customerId", "customerName",
      "buyerDisplayLabel", "costing", "price", "margin",
      /* And the model's own plumbing. */
      "_id", "__v", "revision", "updatedAt", "createdBy", "updatedBy",
    ];
    for (const key of forbidden) expect(keys).not.toContain(key);
    /* Recursively, and by VALUE too — a hash renamed on the way out would
       still be a hash. */
    expect(keys.filter((k) => /fingerprint|digest|hash/i.test(k))).toEqual([]);
    const stored = await IeRelease.findById(ctx.release.releaseId).lean();
    expect(stored.aggregateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.source.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [stored.aggregateFingerprint, stored.source.sourceFingerprint,
      stored.source.sourceApprovalDigest, stored.source.sourceRequirementDigest]) {
      if (secret) expect(JSON.stringify(r)).not.toContain(secret);
    }
    /* No rejection anywhere — no field for one and no value that could be one.
       `rejectedSources` is the single allowed match: it is IE's own list of the
       calendars it refused to cite, and it is evidence, not a decision. */
    expect(keys.filter((k) => /reject/i.test(k))).toEqual(["rejectedSources"]);
    expect(JSON.stringify(r)).not.toMatch(/"REJECTED"/);
  });
  test("rows stay distinguishable by stable id and revision when their codes collide", async () => {
    const co = await company("Collide");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const opA = new mongoose.Types.ObjectId();
    const opB = new mongoose.Types.ObjectId();
    const release = await fabricate(co, {
      rows: [
        {
          rowId: "row_a", sequence: 1,
          ieOperationId: opA, ieOperationRevision: 4,
          /* The SAME display code and the same name — which is exactly the case
             that code matching cannot survive. */
          operationCode: "OP-7", operationName: "Attach collar", machineType: "SNLS",
          standardTimeMinutes: 1.1, standardTimeSource: "METHOD_STUDY",
          requirementSnapshot: {
            capturedAt: new Date("2026-08-01T00:00:00Z"), ieOperationRevision: 4,
            requirementsConfigured: true, machineTypes: [{ machineType: "SNLS", quantity: 1 }],
          },
        },
        {
          rowId: "row_b", sequence: 2,
          ieOperationId: opB, ieOperationRevision: 9,
          operationCode: "OP-7", operationName: "Attach collar", machineType: "OL4",
          standardTimeMinutes: 0.6, standardTimeSource: "METHOD_STUDY",
          requirementSnapshot: {
            capturedAt: new Date("2026-08-02T00:00:00Z"), ieOperationRevision: 9,
            requirementsConfigured: true, machineTypes: [{ machineType: "OL4", quantity: 2 }],
          },
        },
      ],
    });

    const res = await ppc(`/ie-releases/${release._id}`, { token: viewer.token, company: co._id });
    expect(res.status).toBe(200);
    const [a, b] = res.body.release.bulletin.rows;

    /* Identical labels... */
    expect(a.operationCode).toBe(b.operationCode);
    expect(a.operationName).toBe(b.operationName);
    /* ...and still two different operations, at two different revisions. */
    expect(a.ieOperationId).toBe(String(opA));
    expect(b.ieOperationId).toBe(String(opB));
    expect(a.ieOperationId).not.toBe(b.ieOperationId);
    expect(a.ieOperationRevision).toBe(4);
    expect(b.ieOperationRevision).toBe(9);
    expect(a.requirementSnapshot.ieOperationRevision).toBe(4);
    expect(b.requirementSnapshot.machineTypes).toEqual([{ machineType: "OL4", quantity: 2 }]);
  });

  test("the requirement evidence is the release's frozen copy, not a live library lookup", async () => {
    const ctx = await issued("FrozenRequirement");
    const before = await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    const row = before.body.release.bulletin.rows[0];
    expect(row.requirementSnapshot.machineTypes).toEqual([{ machineType: "SNLS", quantity: 1 }]);

    /* Reconfigure the operation in IE's library, straight at the collection so
       nothing about this suite depends on an IE verb. A live lookup would now
       answer an APPROVED, ISSUED handover with today's configuration. */
    const changed = await mongoose.connection.collection("ie_operations").updateOne(
      { _id: new mongoose.Types.ObjectId(row.ieOperationId) },
      {
        $set: {
          machineRequirements: [{ machineType: "FOA", quantity: 5 }],
          revision: row.ieOperationRevision + 7,
        },
      },
    );
    expect(changed.matchedCount).toBe(1);

    const after = await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(after.body.release.bulletin.rows[0]).toEqual(row);
    expect(after.body.release.bulletin.rows[0].requirementSnapshot.machineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 1 }]);
  });

  test("an unusable view or limit is a typed refusal, never a 500 and never a silent correction", async () => {
    const ctx = await issued("ListInputs");
    const q = (qs) => ppc(`/ie-releases${qs}`, { token: ctx.viewer.token, company: ctx.co._id });

    const bad = [
      "?view=everything", "?view=PENDING", "?view=rejected",
      "?limit=0", "?limit=-3", "?limit=2.5", "?limit=abc",
      "?limit=Infinity", "?limit=NaN",
    ];
    const refused = await Promise.all(bad.map(q));
    refused.forEach((res, i) => {
      expect(`${bad[i]} -> ${res.status} ${res.body?.error?.code || ""}`)
        .toBe(`${bad[i]} -> 400 VALIDATION`);
    });

    /* ── AND A NON-SCALAR LIMIT ─────────────────────────────────────────
       Asserted at the service, not through a query string: Express 5 parses
       queries with `querystring` rather than `qs`, so `?limit[]=2` never
       reaches the handler as an array at all. It would under an `extended`
       parser, and whether this app keeps that default is not this service's
       fact to depend on — so the guard is proved where it lives. */
    const ack = require("../../services/ppc/ieReleaseAck.service");
    for (const shape of [["2"], { a: "2" }, [2, 3]]) {
      await expect(ack.listReleases({ companyId: ctx.co._id }, { limit: shape }))
        .rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    }

    /* A fractional limit must never reach Mongo as a `$limit`. */
    expect(refused.every((r) => r.status !== 500)).toBe(true);

    /* Omitted is the default; above the maximum is CAPPED, and the cap is
       stated in the reply rather than left to be inferred. */
    const dflt = await q("");
    expect(dflt.status).toBe(200);
    expect(dflt.body.view).toBe("pending");
    expect(dflt.body.limit).toBe(25);
    /* `1e3` is a number, and a number above the cap is capped — not refused.
       The rule is about usability, not about notation. */
    expect((await q("?limit=1e3")).body.limit).toBe(100);
    const capped = await q("?limit=5000");
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(100);
    expect(capped.body.maxLimit).toBe(100);
    expect((await q("?limit=3&view=all")).body.limit).toBe(3);
  });
});

/* ══ 5. THE DECISION ══════════════════════════════════════════════════════ */

describe("answering a release", () => {
  test("accepting writes one immutable receipt, attributed to the signed-in person", async () => {
    const ctx = await issued("Accept");
    const before = await IeRelease.findById(ctx.release.releaseId).lean();

    const res = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(res.status).toBe(200);
    expect(res.body.receipt.state).toBe("ACCEPTED");
    expect(res.body.receipt.clarification).toBeNull();
    expect(res.body.effectiveState).toBe("ACCEPTED");
    expect(res.body.releaseState).toBe("ISSUED");
    expect(res.body.booksCapacity).toBe(false);
    expect(res.body.writesProduction).toBe(false);

    const rows = await IeReleaseReceipt.find({}).lean();
    expect(rows).toHaveLength(1);
    const [receipt] = rows;
    expect(receipt.state).toBe(RECEIPT_STATE.ACCEPTED);
    expect(String(receipt.ieReleaseId)).toBe(ctx.release.releaseId);
    expect(receipt.releaseRef).toBe(ctx.release.releaseRef);
    expect(receipt.releaseVersionNo).toBe(1);
    /* From the session, never from a body. */
    expect(String(receipt.decidedBy.id)).toBe(ctx.approver.employeeId);
    expect(receipt.decidedBy.name).toBe(ctx.approver.name);
    expect(receipt.decidedAt).toBeInstanceOf(Date);

    /* ── AND THE RELEASE IS UNTOUCHED ─────────────────────────────────── */
    const after = await IeRelease.findById(ctx.release.releaseId).lean();
    expect(after.state).toBe("ISSUED");
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("a clarification needs a known category and a reason worth reading", async () => {
    const ctx = await issued("Clarify");
    const url = `/ie-releases/${ctx.release.releaseId}/clarify`;
    const post = (body) => ppc(url, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body, key: nextKey(),
    });

    expect((await post({ reason: "x".repeat(40) })).status).toBe(400);
    expect((await post({ category: "SOMETHING_ELSE", reason: "x".repeat(40) })).status).toBe(400);
    expect((await post({ category: "OTHER", reason: "too short" })).status).toBe(400);
    expect((await post({ category: "OTHER", reason: "x".repeat(2100) })).status).toBe(400);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);

    const allowed = (await post({ category: "OTHER", reason: "x".repeat(40) })).body;
    expect(allowed).toBeTruthy();
    await IeReleaseReceipt.collection.deleteMany({});

    /* Whitespace is normalised before it is validated, stored or hashed. */
    const ctx2 = await issued("ClarifyNorm");
    const res = await ppc(`/ie-releases/${ctx2.release.releaseId}/clarify`, {
      method: "POST", token: ctx2.approver.token, company: ctx2.co._id, key: nextKey(),
      body: { category: "  ramp_assumption  ", reason: "  The   first-week   ramp is not agreed.  " },
    });
    expect(res.status).toBe(200);
    expect(res.body.receipt.state).toBe("CLARIFICATION_REQUESTED");
    expect(res.body.receipt.clarification).toEqual({
      category: "RAMP_ASSUMPTION",
      reason: "The first-week ramp is not agreed.",
    });
    expect(res.body.effectiveState).toBe("CLARIFICATION_REQUESTED");
  });

  test("accept takes no business fields, and neither route reads actor, company, state or key from a body", async () => {
    const ctx = await issued("BodyFields");
    const other = await actor({ companies: [ctx.co], grants: { ppc: "approver" } });

    const smuggled = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { decidedBy: { id: other.employeeId, name: other.name }, state: "ACCEPTED" },
    });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error.details.fields).toEqual(
      expect.arrayContaining(["decidedBy", "state"]),
    );

    const keyInBody = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { category: "OTHER", reason: "x".repeat(40), idempotencyKey: "smuggled" },
    });
    expect(keyInBody.status).toBe(400);

    /* An acceptance is the absence of a qualification, so it carries nothing. */
    const conditional = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { note: "accepted subject to a later ramp review" },
    });
    expect(conditional.status).toBe(400);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);

    /* And a decision with NO key at all is refused outright. */
    const noKey = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {},
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("there is no reject route, and no reject state to reach", async () => {
    const ctx = await issued("NoReject");
    for (const verb of ["reject", "decline", "refuse", "return"]) {
      const res = await ppc(`/ie-releases/${ctx.release.releaseId}/${verb}`, {
        method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
      });
      expect(res.status).toBe(404);
    }
    const { RECEIPT_STATES } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
    expect(RECEIPT_STATES).toEqual(["ACCEPTED", "CLARIFICATION_REQUESTED"]);
    /* Not even by writing it directly: the enum refuses the value. */
    await expect(IeReleaseReceipt.create([{
      companyId: ctx.co._id, releaseRef: ctx.release.releaseRef, releaseVersionNo: 1,
      ieReleaseId: ctx.release.releaseId, ieStyleFileId: ctx.w.fileId,
      state: "REJECTED", decidedBy: { id: new mongoose.Types.ObjectId() },
      decidedAt: new Date(), idempotencyKey: "k", requestHash: "h",
    }])).rejects.toThrow(/validation/i);
  });
});

/* ══ 6. IDEMPOTENCY AND CONCURRENCY ═══════════════════════════════════════ */

describe("one version, one answer", () => {
  test("the same key with the same request replays; with a different request it is refused", async () => {
    const ctx = await issued("Replay");
    const key = nextKey();
    const body = { category: "OPERATION_BULLETIN", reason: "Row three has no attachment named." };

    const first = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body, key,
    });
    expect(first.status).toBe(200);
    /* `once()` answers the question on every reply, so a first decision says
       so explicitly rather than leaving the caller to infer it from silence. */
    expect(first.body.replayed).toBe(false);

    const again = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body, key,
    });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect({ ...again.body, replayed: false }).toEqual(first.body);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);

    const changed = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key,
      body: { ...body, reason: "Row three has no attachment named, and never did." },
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    /* The same key on the OTHER verb is a different request too. */
    const flipped = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key,
    });
    expect(flipped.status).toBe(409);
    expect(flipped.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);
  });

  test("the receipt's OWN key and request hash classify a decision that the ledger never saw", async () => {
    /* ── WHY THIS IS NOT THE TEST ABOVE ─────────────────────────────────
       Above, the ledger answers first and `once()` never reaches the command.
       The lost-race path has no ledger row to read — the winner writes its row
       BEFORE the ledger is bound — so the classification has to come from the
       receipt itself. A receipt written directly, with no ledger row beside it,
       is that situation exactly, and deterministically. */
    const { hashRequest } = require("../../services/ppc/commandOnce");
    const ctx = await issued("RaceClassify");
    const key = nextKey();
    const winner = {
      decision: "clarify", category: "RAMP_ASSUMPTION",
      reason: "The ramp stage was not agreed with the floor.",
    };
    await IeReleaseReceipt.create([{
      companyId: ctx.co._id,
      releaseRef: ctx.release.releaseRef,
      releaseVersionNo: ctx.release.versionNo,
      ieReleaseId: ctx.release.releaseId,
      ieStyleFileId: ctx.w.fileId,
      state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
      clarification: { category: winner.category, reason: winner.reason },
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "Winner" },
      decidedAt: new Date(),
      idempotencyKey: key,
      requestHash: hashRequest(winner),
    }]);

    /* My key, my request — my own retry, replayed. */
    const same = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key,
      body: { category: winner.category, reason: winner.reason },
    });
    expect(same.status).toBe(200);
    expect(same.body.replayed).toBe(true);
    expect(same.body.receipt.decidedByName).toBe("Winner");

    /* My key, a DIFFERENT request — refused, not silently given somebody
       else's answer. */
    const different = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { category: winner.category, reason: winner.reason },
    });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IE_RELEASE_ALREADY_ACKNOWLEDGED");

    const reused = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key,
      body: { category: "OTHER", reason: "Something else entirely, under the same key." },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);
  });

  test("a retry replays even when the ledger write was lost and the release has since moved", async () => {
    /* ── THE SEQUENCE THIS EXISTS FOR ───────────────────────────────────
       The receipt is written BEFORE the command ledger is bound, so there is a
       real window in which a decision has succeeded and no ledger row exists to
       replay it from. If IE supersedes or withdraws the release inside that
       window, the caller's retry arrives at a release that can no longer be
       decided — and a retry of a decision that ALREADY SUCCEEDED must not be
       told it failed. The receipt's own key is what settles it.

       The seeded receipt with no ledger row beside it is that window, exactly
       and deterministically. */
    const { hashRequest } = require("../../services/ppc/commandOnce");

    for (const moved of ["SUPERSEDED", "WITHDRAWN"]) {
      const ctx = await issued(`LostLedger${moved}`);
      const key = nextKey();
      const request = { decision: "accept", category: "", reason: "" };
      await IeReleaseReceipt.create([{
        companyId: ctx.co._id,
        releaseRef: ctx.release.releaseRef,
        releaseVersionNo: ctx.release.versionNo,
        ieReleaseId: ctx.release.releaseId,
        ieStyleFileId: ctx.w.fileId,
        state: RECEIPT_STATE.ACCEPTED,
        decidedBy: { id: new mongoose.Types.ObjectId(), name: "First Caller" },
        decidedAt: new Date("2026-09-15T00:00:00Z"),
        idempotencyKey: key,
        requestHash: hashRequest(request),
      }]);
      /* No ledger row — the write that would have created one was lost. */
      const { MerchandisingCommandLedger } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
      expect(await MerchandisingCommandLedger.countDocuments({
        scope: `ppc:ie-release:${ctx.release.releaseId}`,
      })).toBe(0);

      await mongoose.connection.collection("ie_releases").updateOne(
        { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
        { $set: { state: moved, ...(moved === "SUPERSEDED" ? { supersededByVersionNo: 2 } : {}) } },
      );

      /* THE RETRY. Same key, same request — the original 200, restated. */
      const retry = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
        method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.receipt.state).toBe("ACCEPTED");
      expect(retry.body.receipt.decidedByName).toBe("First Caller");
      /* Replayed against the world as it is now, not as it was: the decision is
         unchanged and the derived state is honest about what has happened. */
      expect(retry.body.releaseState).toBe(moved);
      expect(retry.body.effectiveState)
        .toBe(moved === "SUPERSEDED" ? "ACCEPTED_SUPERSEDED" : "WITHDRAWN");

      /* Same key, DIFFERENT request — still refused as a reuse, not replayed. */
      const reused = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
        method: "POST", token: ctx.approver.token, company: ctx.co._id, key,
        body: { category: "OTHER", reason: "Something else entirely, under that key." },
      });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      /* ── AND A GENUINELY NEW DECISION IS STILL FORBIDDEN ───────────────
         A different key has decided nothing, so it is judged by the lifecycle
         and gets the lifecycle's answer — never `ALREADY_ACKNOWLEDGED`, which
         would invite a caller to think answering the current version was the
         only thing standing in their way. */
      const fresh = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
        method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
        body: { category: "OTHER", reason: "A brand new decision on a moved release." },
      });
      expect(fresh.status).toBe(409);
      expect(fresh.body.error.code)
        .toBe(moved === "SUPERSEDED" ? "IE_RELEASE_VERSION_SUPERSEDED" : "IE_RELEASE_WITHDRAWN");

      expect(await IeReleaseReceipt.countDocuments({ ieReleaseId: ctx.release.releaseId })).toBe(1);
      await IeReleaseReceipt.collection.deleteMany({});
    }
  });

  test("a second answer under another key is refused as already acknowledged", async () => {
    const ctx = await issued("Second");
    expect((await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    })).status).toBe(200);

    const other = await actor({ companies: [ctx.co], grants: { ppc: "approver" } });
    const second = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: other.token, company: ctx.co._id, key: nextKey(),
      body: { category: "OTHER", reason: "Second thoughts about this standard." },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IE_RELEASE_ALREADY_ACKNOWLEDGED");
    expect(second.body.error.details.receiptState).toBe("ACCEPTED");

    const rows = await IeReleaseReceipt.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("ACCEPTED");
  });

  test("two simultaneous answers produce ONE receipt, and no duplicate-key error escapes", async () => {
    /* Same key, same request: both are the same retry, and both get the 200. */
    const same = await issued("RaceSame");
    const key = nextKey();
    const both = await Promise.all([1, 2].map(() => ppc(
      `/ie-releases/${same.release.releaseId}/accept`,
      { method: "POST", token: same.approver.token, company: same.co._id, body: {}, key },
    )));
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.filter((r) => r.body.replayed === true)).toHaveLength(1);
    expect(both.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(await IeReleaseReceipt.countDocuments({ ieReleaseId: same.release.releaseId })).toBe(1);

    /* Different keys, different decisions: one wins, one is told so — and the
       loser never sees an 11000 or a 500. */
    const rival = await issued("RaceRival");
    const second = await actor({ companies: [rival.co], grants: { ppc: "approver" } });
    const contested = await Promise.all([
      ppc(`/ie-releases/${rival.release.releaseId}/accept`, {
        method: "POST", token: rival.approver.token, company: rival.co._id, body: {}, key: nextKey(),
      }),
      ppc(`/ie-releases/${rival.release.releaseId}/clarify`, {
        method: "POST", token: second.token, company: rival.co._id, key: nextKey(),
        body: { category: "OTHER", reason: "Hold on, the ramp is not agreed yet." },
      }),
    ]);
    const statuses = contested.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = contested.find((r) => r.status === 409);
    expect(refused.body.error.code).toBe("IE_RELEASE_ALREADY_ACKNOWLEDGED");
    expect(JSON.stringify(refused.body)).not.toMatch(/E11000|duplicate key/i);
    expect(await IeReleaseReceipt.countDocuments({ ieReleaseId: rival.release.releaseId })).toBe(1);
  });
});

/* ══ 7. LIFECYCLE ═════════════════════════════════════════════════════════ */

describe("what can no longer be answered", () => {
  test("a superseded version is refused, and the refusal names the current one", async () => {
    const ctx = await issued("Superseded");
    const successor = await issueSuccessor(ctx, 40);
    expect(successor.versionNo).toBe(2);

    const res = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_VERSION_SUPERSEDED");
    expect(res.body.error.details).toEqual({ versionNo: 1, currentVersionNo: 2 });
    expect(res.body.message).toMatch(/version 2/);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);
  });

  test("a withdrawn release is refused", async () => {
    const ctx = await issued("Withdrawn");
    await mongoose.connection.collection("ie_releases")
      .updateOne({ _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
        { $set: { state: "WITHDRAWN" } });

    const res = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { category: "OTHER", reason: "Trying to answer a withdrawn release." },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_WITHDRAWN");
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);
  });

  test("a successor is independently pending, and the older receipt is untouched", async () => {
    const ctx = await issued("Successor");
    const accepted = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(accepted.status).toBe(200);
    const before = await IeReleaseReceipt.findOne({}).lean();

    const successor = await issueSuccessor(ctx, 40);

    /* Nothing was written to PPC for the new version, and nothing changed for
       the old one. "PPC accepted version 1 on the 20th" stays true and stays
       stored — only the DERIVED state moves. */
    const after = await IeReleaseReceipt.findOne({}).lean();
    expect(after).toEqual(before);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);

    expect(await stateOf(ctx.co, ctx.release.releaseId, ctx.viewer)).toBe("ACCEPTED_SUPERSEDED");
    expect(await stateOf(ctx.co, successor.releaseId, ctx.viewer)).toBe("PENDING");

    const pending = await ppc("/ie-releases?view=pending", {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(pending.body.rows.map((r) => r.releaseId)).toEqual([successor.releaseId]);

    /* And it can be answered on its own merits. */
    const answered = await ppc(`/ie-releases/${successor.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { category: "CAPACITY_STANDARD", reason: "Forty operators are not on this line." },
    });
    expect(answered.status).toBe(200);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(2);
  });
});

/* ══ 8. THE RECEIPT IS EVIDENCE ═══════════════════════════════════════════ */

describe("a recorded decision cannot be unrecorded", () => {
  test("every update, replacement and deletion path is refused", async () => {
    const ctx = await issued("Immutable");
    expect((await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    })).status).toBe(200);
    const row = await IeReleaseReceipt.findOne({}).lean();
    const id = row._id;
    const before = JSON.stringify(row);

    const refused = async (label, run) => {
      await expect(run()).rejects.toThrow(/cannot be (amended|replaced|deleted|re-saved)/);
      expect(label).toBeTruthy();
    };

    await refused("updateOne", () => IeReleaseReceipt.updateOne({ _id: id }, { $set: { state: "CLARIFICATION_REQUESTED" } }));
    await refused("updateMany", () => IeReleaseReceipt.updateMany({}, { $set: { state: "ACCEPTED" } }));
    await refused("findOneAndUpdate", () => IeReleaseReceipt.findOneAndUpdate({ _id: id }, { $set: { "clarification.reason": "x" } }));
    await refused("findByIdAndUpdate", () => IeReleaseReceipt.findByIdAndUpdate(id, { $set: { releaseVersionNo: 9 } }));
    await refused("replaceOne", () => IeReleaseReceipt.replaceOne({ _id: id }, { ...row, state: "ACCEPTED" }));
    await refused("findOneAndReplace", () => IeReleaseReceipt.findOneAndReplace({ _id: id }, { ...row }));
    await refused("deleteOne", () => IeReleaseReceipt.deleteOne({ _id: id }));
    await refused("deleteMany", () => IeReleaseReceipt.deleteMany({}));
    await refused("findOneAndDelete", () => IeReleaseReceipt.findOneAndDelete({ _id: id }));
    await refused("findByIdAndDelete", () => IeReleaseReceipt.findByIdAndDelete(id));

    /* And through a loaded document, which is a different Mongoose path. */
    const doc = await IeReleaseReceipt.findById(id);
    doc.state = "CLARIFICATION_REQUESTED";
    await refused("save", () => doc.save());
    await refused("doc.deleteOne", () => doc.deleteOne());

    expect(JSON.stringify(await IeReleaseReceipt.findById(id).lean())).toBe(before);
  });
});

describe("the receipt refuses incoherent evidence even when written directly", () => {
  const base = (co, release, fileId) => ({
    companyId: co._id,
    releaseRef: release.releaseRef,
    releaseVersionNo: release.versionNo,
    ieReleaseId: release.releaseId,
    ieStyleFileId: fileId,
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "Direct" },
    decidedAt: new Date(),
    idempotencyKey: "direct-key",
    requestHash: "direct-hash",
  });

  test("an acceptance carrying a complaint, and a complaint carrying nothing to act on, are both refused", async () => {
    /* The route normalises and validates before it writes — but the route is
       not the only caller a model ever has, and a row written by a script is
       just as permanent. Because it can never be corrected afterwards, the rule
       has to hold at the point of writing. */
    const ctx = await issued("Structural");
    const row = base(ctx.co, ctx.release, ctx.w.fileId);

    const refusals = [
      ["accepted with a category", {
        ...row, state: "ACCEPTED", clarification: { category: "OTHER", reason: "" },
      }],
      ["accepted with a reason", {
        ...row, state: "ACCEPTED", clarification: { reason: "x".repeat(40) },
      }],
      ["clarification with no category", {
        ...row, state: "CLARIFICATION_REQUESTED", clarification: { reason: "x".repeat(40) },
      }],
      ["clarification with an unlisted category", {
        ...row, state: "CLARIFICATION_REQUESTED",
        clarification: { category: "SOMETHING_ELSE", reason: "x".repeat(40) },
      }],
      ["clarification with too short a reason", {
        ...row, state: "CLARIFICATION_REQUESTED",
        clarification: { category: "OTHER", reason: "too short" },
      }],
      ["clarification with too long a reason", {
        ...row, state: "CLARIFICATION_REQUESTED",
        clarification: { category: "OTHER", reason: "x".repeat(2001) },
      }],
      ["clarification with an unnormalised reason", {
        ...row, state: "CLARIFICATION_REQUESTED",
        clarification: { category: "OTHER", reason: "Two  spaces in the middle of this reason." },
      }],
    ];

    for (const [label, doc] of refusals) {
      await expect(IeReleaseReceipt.create([doc]))
        .rejects.toThrow(/coherent decision|validation/i);
      /* And nothing was written on the way to being refused. */
      expect(`${label}:${await IeReleaseReceipt.countDocuments({})}`).toBe(`${label}:0`);
    }

    /* The two coherent shapes are accepted. */
    const [accepted] = await IeReleaseReceipt.create([{ ...row, state: "ACCEPTED" }]);
    expect(accepted.state).toBe("ACCEPTED");
    await IeReleaseReceipt.collection.deleteMany({});
    const [clarified] = await IeReleaseReceipt.create([{
      ...row, state: "CLARIFICATION_REQUESTED",
      clarification: { category: "RAMP_ASSUMPTION", reason: "The ramp stage was never agreed." },
    }]);
    expect(clarified.clarification.category).toBe("RAMP_ASSUMPTION");
  });

  test("one release document cannot acquire two receipts, by either unique index", async () => {
    const ctx = await issued("TwoIndexes");
    const row = base(ctx.co, ctx.release, ctx.w.fileId);
    await IeReleaseReceipt.create([{ ...row, state: "ACCEPTED" }]);

    /* The business identity index. */
    await expect(IeReleaseReceipt.create([{
      ...row, state: "ACCEPTED", idempotencyKey: "another",
    }])).rejects.toThrow(/duplicate key/i);

    /* And the document index, which catches a second receipt that carries a
       DIFFERENT business reference for the same release — the case the first
       index cannot see. */
    await expect(IeReleaseReceipt.create([{
      ...row, state: "ACCEPTED", releaseVersionNo: 99, releaseRef: "IEREL-SOMETHINGELSE",
      idempotencyKey: "another",
    }])).rejects.toThrow(/duplicate key/i);

    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);

    const indexes = await IeReleaseReceipt.collection.indexes();
    const unique = indexes.filter((i) => i.unique).map((i) => Object.keys(i.key).join("+"));
    expect(unique).toEqual(expect.arrayContaining([
      "companyId+releaseRef+releaseVersionNo",
      "companyId+ieReleaseId",
    ]));
  });
});

/* ══ 9. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("the boundary between the two departments", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");
  const listJs = (dir) => fs.readdirSync(path.join(__dirname, "..", "..", dir))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `${dir}/${f}`);

  test("nothing in services/industrialEngineering imports or writes the PPC receipt", async () => {
    const offenders = [];
    for (const file of listJs("services/industrialEngineering")) {
      const text = read(file);
      if (/require\([^)]*PPC[^)]*\)/i.test(text)) offenders.push(`${file}: requires a PPC model`);
      if (/require\([^)]*services\/ppc[^)]*\)/i.test(text)) offenders.push(`${file}: requires a PPC service`);
      if (/IeReleaseReceipt/.test(text)) offenders.push(`${file}: names IeReleaseReceipt`);
      if (/ppc_ie_release_receipts/.test(text)) offenders.push(`${file}: names PPC's collection`);
    }
    expect(offenders).toEqual([]);
  });

  test("the acknowledgement writes no release, no outbox, no delivery row and no work order", async () => {
    const text = read("services/ppc/ieReleaseAck.service.js");
    /* Reads of `ie_releases` are the whole delivery mechanism; WRITES of it are
       the thing that must not exist. Matched as call sites, not as prose. */
    expect(text).not.toMatch(/IeRelease\.(create|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|bulkWrite|insertMany)\b/);
    for (const forbidden of [
      /require\([^)]*[Oo]utbox[^)]*\)/,
      /require\([^)]*WorkOrder[^)]*\)/,
      /require\([^)]*[Bb]arcode[^)]*\)/,
      /require\([^)]*Production[^)]*\)/,
      /setInterval|node-cron|scheduleJob/,
    ]) expect(text).not.toMatch(forbidden);

    /* And no such collection exists to be written. */
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    expect(names.filter((n) => /ie.*outbox|release.*outbox|release.*deliver/i.test(n))).toEqual([]);
  });

  test("a PPC decision never mutates the IE release, at the collection level", async () => {
    const ctx = await issued("NoMutation");
    const snapshot = await mongoose.connection.collection("ie_releases")
      .find({ companyId: ctx.co._id }).toArray();

    expect((await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: { category: "WORKING_TIME_ASSUMPTION", reason: "We do not run two shifts in October." },
    })).status).toBe(200);

    const after = await mongoose.connection.collection("ie_releases")
      .find({ companyId: ctx.co._id }).toArray();
    expect(JSON.stringify(after)).toBe(JSON.stringify(snapshot));
  });

  test("the receipt model exposes only PPC's own two decisions", () => {
    expect(Object.values(RECEIPT_STATE)).toEqual(["ACCEPTED", "CLARIFICATION_REQUESTED"]);
    expect(CLARIFICATION_CATEGORY).toEqual([
      "OPERATION_BULLETIN", "LINE_LAYOUT", "CAPACITY_STANDARD",
      "RAMP_ASSUMPTION", "WORKING_TIME_ASSUMPTION", "OTHER",
    ]);
    /* No derived state is ever persisted: the schema has no path for one. */
    expect(IeReleaseReceipt.schema.path("effectiveState")).toBeUndefined();
    expect(IeReleaseReceipt.schema.path("state").enumValues)
      .toEqual(["ACCEPTED", "CLARIFICATION_REQUESTED"]);
  });
});

/* ══ 10. THE WHOLE HANDOVER, WALKED ONCE ══════════════════════════════════
 *
 * Every claim above is proved in isolation, which is how a claim should be
 * proved. But the handover is a JOURNEY, and a journey can be broken by a seam
 * that neither side's own tests look at: IE's issue endpoint could emit a shape
 * PPC's queue silently skips, and both suites would still be green.
 *
 * So this walks it end to end, at the wire, exactly once — IE issues, the
 * release appears as PPC's work, PPC reads it, PPC answers it, and the answer is
 * one immutable receipt that moved nothing else. No fabricated release and no
 * service called directly: every step is an HTTP request through a mounted
 * router, in the order a person performs them.
 */

describe("the connected journey", () => {
  test("IE issues → PPC's pending queue → detail → accept → one immutable receipt", async () => {
    /* ── 1. IE ISSUES ─────────────────────────────────────────────────────
       `issued` drives IE's own routes throughout: the operation library, the
       bulletin, four method studies, the approved bulletin version, the approved
       layout, the approved capacity standard, and finally
       POST /api/cms/ie/style-files/:fileId/releases. */
    /* With a real ramp stage on the capacity standard, so all five of the
       required approved facts are genuinely in the payload. */
    let ramp;
    const ctx = await issued("Journey", async (w) => {
      ramp = await rampStage(w);
      return { ramp: ramp.ramp };
    });
    expect(ctx.release.state).toBe("ISSUED");
    expect(ctx.release.versionNo).toBe(1);
    expect(ctx.release.releaseRef).toMatch(/^IEREL-[0-9A-F]{10}$/);

    /* What PPC must not have yet, and what Merchandising and Production must
       still look like when this is over. */
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);
    const stylesBefore = await SampleStyle.find({}).lean();
    const ordersBefore = await WorkOrder.find({}).lean();
    const releasesBefore = await mongoose.connection.collection("ie_releases")
      .find({ companyId: ctx.co._id }).toArray();

    /* ── 2. IT IS PPC'S WORK, IN PPC'S OWN APPLICATION ───────────────────
       Discovered through PPC's company list — the actor's own memberships —
       and then read from PPC's queue under that company. */
    const companies = await ppc("/companies", { token: ctx.viewer.token });
    expect(companies.status).toBe(200);
    expect(companies.body.companies.map((c) => String(c.companyId)))
      .toContain(String(ctx.co._id));

    const pending = await ppc("/ie-releases?view=pending", {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(pending.status).toBe(200);
    expect(pending.body.view).toBe("pending");
    const queued = pending.body.rows.find((r) => r.releaseId === ctx.release.releaseId);
    expect(queued).toBeTruthy();
    expect(queued.effectiveState).toBe("PENDING");
    expect(queued.releaseRef).toBe(ctx.release.releaseRef);

    /* ── 3. PPC READS THE WHOLE FROZEN STANDARD ──────────────────────────
       The five things IE approved, present and complete — and the two the
       screen must be able to say in words. */
    const detail = await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(detail.status).toBe(200);
    const r = detail.body.release;
    expect(r.bulletin.versionNo).toBeGreaterThanOrEqual(1);
    expect(r.bulletin.rows).toHaveLength(4);
    expect(r.lineLayout.stations).toHaveLength(2);
    expect(r.capacity.calculation.wholePieceDailyTarget).toBeGreaterThan(0);

    /* The ramp, as the stage IE approved — not the steady-state target, and not
       the standard's own `targetEfficiencyPercent`. */
    expect(r.ramp).toBeTruthy();
    expect(r.ramp.stageLabel).toBe("Settling");
    expect(r.ramp.fromProductionDay).toBe(4);
    expect(r.ramp.toProductionDay).toBe(10);
    expect(r.ramp.targetEfficiencyPercent).toBe(60);
    expect(r.ramp.rampProfileName).toBe(ramp.profile.name);
    /* And the ramp stage's own daily target, from the same calculator — lower
       than the steady-state one, because 60% is not 60%'s answer to 60%. */
    expect(r.capacity.rampCalculation.wholePieceDailyTarget).toBeGreaterThan(0);
    expect(r.capacity.rampCalculation.wholePieceDailyTarget)
      .toBe(r.capacity.calculation.wholePieceDailyTarget);

    /* The working-time assumption, stated in full rather than resolved away. */
    expect(r.workingTime.calendarLinkage.state).toBeTruthy();
    expect(r.readiness.state).toBeTruthy();
    expect(r.effectiveState).toBe("PENDING");
    expect(r.decidable).toBe(true);
    expect(r.booksCapacity).toBe(false);
    expect(r.writesProduction).toBe(false);

    /* ── 4. PPC ANSWERS IT ───────────────────────────────────────────────
       The approver accepts. A viewer could not have. */
    const asViewer = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.viewer.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.error.code).toBe("IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN");
    expect(await IeReleaseReceipt.countDocuments({})).toBe(0);

    const key = nextKey();
    const accepted = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.receipt.state).toBe("ACCEPTED");
    expect(accepted.body.effectiveState).toBe("ACCEPTED");
    expect(accepted.body.booksCapacity).toBe(false);
    expect(accepted.body.writesProduction).toBe(false);

    /* ── 5. ONE IMMUTABLE RECEIPT, AND NOTHING ELSE MOVED ────────────────
       Acceptance means the standard was RECEIVED. It books no capacity, it
       allocates no line, it releases no Production, and it does not reach into
       a record Merchandising owns. */
    const receipts = await IeReleaseReceipt.find({}).lean();
    expect(receipts).toHaveLength(1);
    expect(String(receipts[0].ieReleaseId)).toBe(ctx.release.releaseId);
    expect(String(receipts[0].decidedBy.id)).toBe(ctx.approver.employeeId);
    /* An acceptance is the ABSENCE of a qualification: no category, and nothing
       to read. (`reason` has a `""` schema default, so the subdocument
       materialises empty rather than not at all; the envelope nulls it.) */
    expect(receipts[0].clarification?.category).toBeUndefined();
    expect(receipts[0].clarification?.reason || "").toBe("");
    expect(accepted.body.receipt.clarification).toBeNull();

    expect(JSON.stringify(await mongoose.connection.collection("ie_releases")
      .find({ companyId: ctx.co._id }).toArray())).toBe(JSON.stringify(releasesBefore));
    expect(JSON.stringify(await WorkOrder.find({}).lean())).toBe(JSON.stringify(ordersBefore));
    expect(JSON.stringify(await SampleStyle.find({}).lean())).toBe(JSON.stringify(stylesBefore));

    /* ── 6. THE COMMAND IS ANSWERED ONCE ─────────────────────────────────
       The retry replays the original answer. The same key carrying a different
       command is refused. A second answer under a fresh key is refused. And
       there is still one receipt. */
    const replay = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.receipt.receiptId).toBe(accepted.body.receipt.receiptId);

    const reused = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key,
      body: { category: "CAPACITY_STANDARD", reason: "Reusing the acceptance key for a question." },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const again = await ppc(`/ie-releases/${ctx.release.releaseId}/accept`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, body: {}, key: nextKey(),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("IE_RELEASE_ALREADY_ACKNOWLEDGED");
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);

    /* ── 7. AND IT HAS LEFT THE QUEUE ────────────────────────────────────
       `PENDING` is the absence of a receipt, so an answered release is simply
       no longer work — and it reads as ACCEPTED under `decided`. */
    const afterPending = await ppc("/ie-releases?view=pending", {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(afterPending.body.rows.map((x) => x.releaseId)).not.toContain(ctx.release.releaseId);
    const afterDecided = await ppc("/ie-releases?view=decided", {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    expect(afterDecided.body.rows.find((x) => x.releaseId === ctx.release.releaseId).effectiveState)
      .toBe("ACCEPTED");
  });

  test("the same journey, answered with a clarification instead — and a successor replaces the question", async () => {
    const ctx = await issued("JourneyClarify");

    /* PPC reads it, and asks rather than accepts. */
    expect((await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    })).body.release.effectiveState).toBe("PENDING");

    const asked = await ppc(`/ie-releases/${ctx.release.releaseId}/clarify`, {
      method: "POST", token: ctx.approver.token, company: ctx.co._id, key: nextKey(),
      body: {
        category: "CAPACITY_STANDARD",
        reason: "Twenty-five operators is not staffed on this line in October.",
      },
    });
    expect(asked.status).toBe(200);
    expect(asked.body.receipt.state).toBe("CLARIFICATION_REQUESTED");
    expect(asked.body.receipt.clarification).toEqual({
      category: "CAPACITY_STANDARD",
      reason: "Twenty-five operators is not staffed on this line in October.",
    });
    expect(asked.body.booksCapacity).toBe(false);
    expect(asked.body.writesProduction).toBe(false);

    /* ── IE ANSWERS THE QUESTION BY ISSUING AGAIN ────────────────────────
       A genuine successor, through IE's own route — which supersedes version 1
       without touching PPC's receipt for it. */
    const successor = await issueSuccessor(ctx, 18);
    expect(successor.versionNo).toBe(2);

    const pending = await ppc("/ie-releases?view=pending&limit=100", {
      token: ctx.viewer.token, company: ctx.co._id,
    });
    const pendingIds = pending.body.rows.map((x) => x.releaseId);
    /* The successor is independently pending. */
    expect(pendingIds).toContain(successor.releaseId);
    /* And version 1 is not — it was answered, and it has been superseded. */
    expect(pendingIds).not.toContain(ctx.release.releaseId);

    /* The older receipt is untouched, and version 1 now reads as both halves. */
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);
    expect((await ppc(`/ie-releases/${ctx.release.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    })).body.release.effectiveState).toBe("CLARIFICATION_REQUESTED_SUPERSEDED");

    /* ── AND A SUPERSEDED RELEASE THAT WAS NEVER ANSWERED IS NOT WORK ────
       Requirement 9, on genuinely issued releases: PPC never answers version 2,
       IE issues version 3, and version 2 leaves the queue without a receipt. */
    const third = await issueSuccessor(ctx, 21);
    expect(third.versionNo).toBe(3);
    const finalPending = (await ppc("/ie-releases?view=pending&limit=100", {
      token: ctx.viewer.token, company: ctx.co._id,
    })).body.rows.map((x) => x.releaseId);
    expect(finalPending).toContain(third.releaseId);
    expect(finalPending).not.toContain(successor.releaseId);
    expect(await IeReleaseReceipt.countDocuments({})).toBe(1);

    /* Version 2 still reads, as a superseded release nobody answered. */
    expect((await ppc(`/ie-releases/${successor.releaseId}`, {
      token: ctx.viewer.token, company: ctx.co._id,
    })).body.release.effectiveState).toBe("SUPERSEDED_UNDECIDED");
  });
});
