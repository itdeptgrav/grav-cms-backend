// test/industrial-engineering/ie-line-template.route.test.js
//
// IE CHUNK 6C — REUSABLE LINE TEMPLATES, AT THE WIRE.
//
// A template travels between styles, which makes IDENTITY the whole of this
// chunk's risk. The claims worth holding are the ones that keep a pattern from
// lending anything it must not:
//
//   · applying mints FRESH layout station ids, and copies no template id, no
//     template station id, no slot id, no row id, no source identity, no
//     revision, no history and no ownership;
//   · a slot resolves through the STABLE `ieOperationId` and never through the
//     mutable `operationCode` — two companies may both hold `OP-1`, and a
//     retired code can be re-used;
//   · the same operation placed twice is told apart by a DETERMINISTIC
//     occurrence, counted in the source's own order;
//   · a pattern that half-fits is refused whole, naming every slot that does
//     not resolve, and writes nothing;
//   · rows the pattern does not place stay unassigned and appear as the
//     coverage gap they already are;
//   · the balance, the machine compatibility and the readiness are recomputed
//     by the layout's own publisher, never carried from the template;
//   · a template and the layouts made from it are independent for ever after;
//   · and nothing here reads Production, a barcode, a scan, a physical machine,
//     an availability or an employee, or approves, releases or plans capacity.
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

  /* Chunk 7C2: a layout is opened against an APPROVED bulletin version. */
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

/* ── CHUNK 6C HELPERS ─────────────────────────────────────────────────────── */

const IeLineTemplate = require("../../models/CMS_Models/IndustrialEngineering/IeLineTemplate");

const openLayout = (a, w) => call(`/engineering-files/${w.fileId}/line-layouts`, {
  method: "POST", token: a.token, company: w.co._id, body: {},
});
const makeTemplate = (a, w, body) => call("/line-templates", {
  method: "POST", token: a.token, company: w.co._id, body,
});
const readTemplate = (a, w, id) => call(`/line-templates/${id}`, { token: a.token, company: w.co._id });
const listTemplates = (a, w, qs = "") => call(`/line-templates${qs}`, { token: a.token, company: w.co._id });
const patchTemplate = (a, w, id, body) => call(`/line-templates/${id}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const retire = (a, w, id, body) => call(`/line-templates/${id}/retire`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const restore = (a, w, id, body) => call(`/line-templates/${id}/restore`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const apply = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}/from-template`, {
  method: "POST", token: a.token, company: w.co._id, body,
});

/**
 * A layout with its four operations arranged into two stations, and planned
 * machine types on each — the pattern every test below captures.
 */
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
        plannedMachineTypes: [{ machineType: "OVERLOCK", quantity: 1 }],
        assignments: [{ rowId: rows[2].rowId }, { rowId: rows[3].rowId }],
      },
    ],
  });
  expect(saved.status).toBe(200);
  return { layout: saved.body.layout, rows };
}

/* ══ 1. THE CONTRACT AND ITS BOUNDARY ═════════════════════════════════════ */

describe("every template endpoint is company-scoped and role-gated", () => {
  const ENDPOINTS = (id, layoutId) => [
    ["POST", "/line-templates", { layoutId, name: "X" }, "editor"],
    ["GET", "/line-templates", undefined, "viewer"],
    ["GET", `/line-templates/${id}`, undefined, "viewer"],
    ["PATCH", `/line-templates/${id}`, { expectedRevision: 1, name: "Y" }, "editor"],
    ["POST", `/line-templates/${id}/retire`, { expectedRevision: 1 }, "editor"],
    ["POST", `/line-templates/${id}/restore`, { expectedRevision: 1 }, "editor"],
    ["POST", `/line-layouts/${layoutId}/from-template`, { templateId: id, expectedRevision: 1 }, "editor"],
  ];

  test("a viewer reads and cannot write; an editor may do both", async () => {
    const w = await world("Gate");
    const { layout } = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Gate pattern" });
    expect(made.status).toBe(201);
    const id = made.body.template.templateId;

    const viewer = await viewerIn(w.co);
    for (const [method, path, body, need] of ENDPOINTS(id, layout.layoutId)) {
      const res = await call(path, { method, body, token: viewer.token, company: w.co._id });
      if (need === "viewer") {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
      }
    }
  });

  test("another company's template is indistinguishable from a missing one", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const { layout } = await arranged(mine);
    const made = await makeTemplate(mine.maker, mine, { layoutId: layout.layoutId, name: "Private" });
    const id = made.body.template.templateId;

    const outsider = await editorIn(theirs.co);
    const t = { token: outsider.token, company: theirs.co._id };

    const read = await call(`/line-templates/${id}`, t);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("IE_LINE_TEMPLATE_NOT_FOUND");

    const ghost = await call(`/line-templates/${new mongoose.Types.ObjectId()}`, t);
    expect(ghost.status).toBe(read.status);
    expect(ghost.body.error.code).toBe(read.body.error.code);
    expect(ghost.body.error.message).toBe(read.body.error.message);

    /* Every write says the same. */
    for (const [method, path, body] of [
      ["PATCH", `/line-templates/${id}`, { expectedRevision: 1, name: "Z" }],
      ["POST", `/line-templates/${id}/retire`, { expectedRevision: 1 }],
      ["POST", `/line-templates/${id}/restore`, { expectedRevision: 1 }],
    ]) {
      const res = await call(path, { method, body, ...t });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_NOT_FOUND");
    }

    /* And it does not appear in their list. */
    const list = await listTemplates(outsider, theirs);
    expect(list.body.templates.map((x) => x.templateId)).not.toContain(id);
  });

  test("capturing from another company's layout is refused as a missing layout", async () => {
    const mine = await world("CapMine");
    const theirs = await world("CapTheirs");
    const { layout } = await arranged(mine);
    const outsider = await editorIn(theirs.co);
    const res = await call("/line-templates", {
      method: "POST", token: outsider.token, company: theirs.co._id,
      body: { layoutId: layout.layoutId, name: "Stolen" },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IE_LINE_LAYOUT_NOT_FOUND");
    expect(await IeLineTemplate.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("applying another company's template to my layout is refused, and writes nothing", async () => {
    const mine = await world("ApplyMine");
    const theirs = await world("ApplyTheirs");
    const foreign = await arranged(theirs);
    const made = await makeTemplate(theirs.maker, theirs, {
      layoutId: foreign.layout.layoutId, name: "Foreign pattern",
    });
    const target = await openLayout(mine.maker, mine);
    const res = await apply(mine.maker, mine, target.body.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.body.layout.revision,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_NOT_FOUND");

    const after = await readLayout(mine.maker, mine, target.body.layout.layoutId);
    expect(after.body.layout.revision).toBe(target.body.layout.revision);
    expect(after.body.layout.stations).toEqual([]);
    expect(after.body.layout.history).toHaveLength(1);
  });
});

describe("the request allowlists are strict", () => {
  test("capture, edit, lifecycle and apply each refuse what they do not accept", async () => {
    const w = await world("Allow");
    const { layout } = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Allow pattern" });
    const id = made.body.template.templateId;

    const cases = [
      ["POST", "/line-templates", { layoutId: layout.layoutId, name: "N", status: "ACTIVE" }],
      ["POST", "/line-templates", { layoutId: layout.layoutId, name: "N", revision: 5 }],
      ["POST", "/line-templates", { layoutId: layout.layoutId, name: "N", companyId: String(w.co._id) }],
      ["PATCH", `/line-templates/${id}`, { expectedRevision: 1, history: [] }],
      ["PATCH", `/line-templates/${id}`, { expectedRevision: 1, capturedFrom: {} }],
      ["PATCH", `/line-templates/${id}`, { expectedRevision: 1, nameKey: "X" }],
      ["POST", `/line-templates/${id}/retire`, { expectedRevision: 1, reason: "why" }],
      ["POST", `/line-layouts/${layout.layoutId}/from-template`, { templateId: id, expectedRevision: 1, stations: [] }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(path, { method, body, token: w.maker.token, company: w.co._id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
  });

  test("a station and a slot accept only their own fields, and no Production concept at all", async () => {
    const w = await world("Slots");
    const { layout } = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Slots pattern" });
    const id = made.body.template.templateId;
    const opId = String(layout.source.rows[0].ieOperationId);

    const refused = [
      /* Identity a template must never lend. */
      [{ label: "S", stationId: "stn_x", slots: [] }, "stationId"],
      [{ label: "S", templateStationId: "tst_x", slots: [] }, "templateStationId"],
      [{ label: "S", slots: [{ ieOperationId: opId, occurrence: 1, rowId: "row_1" }] }, "rowId"],
      [{ label: "S", slots: [{ ieOperationId: opId, occurrence: 1, slotId: "tsl_x" }] }, "slotId"],
      [{ label: "S", slots: [{ operationCode: "OP-1", occurrence: 1 }] }, "operationCode"],
      /* Production, Maintenance and HR. */
      [{ label: "S", slots: [], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, machineId: "m1" }] }, "machineId"],
      [{ label: "S", slots: [], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, serialNumber: "SN-1" }] }, "serialNumber"],
      [{ label: "S", slots: [], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, availability: "FREE" }] }, "availability"],
      [{ label: "S", slots: [{ ieOperationId: opId, occurrence: 1, employeeId: "e1" }] }, "employeeId"],
      [{ label: "S", slots: [{ ieOperationId: opId, occurrence: 1, shift: "A" }] }, "shift"],
      [{ label: "S", slots: [], capacity: 100 }, "capacity"],
      [{ label: "S", slots: [], barcodeId: "bc-1" }, "barcodeId"],
      /* And a calculated figure. */
      [{ label: "S", slots: [], workloadMinutes: 4 }, "workloadMinutes"],
    ];
    for (const [station, why] of refused) {
      const res = await patchTemplate(w.maker, w, id, { expectedRevision: 1, stations: [station] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(JSON.stringify(res.body.error)).toContain(why);
    }
    /* And none of them moved the record. */
    const after = await readTemplate(w.maker, w, id);
    expect(after.body.template.revision).toBe(1);
    expect(after.body.template.history).toHaveLength(1);
  });
});

/* ══ 2. CAPTURE ═══════════════════════════════════════════════════════════ */

describe("capturing a pattern keeps the shape and none of the identity", () => {
  test("the pattern crosses; the layout's identity does not", async () => {
    const w = await world("Capture");
    const { layout } = await arranged(w);
    const made = await makeTemplate(w.maker, w, {
      layoutId: layout.layoutId, name: "Tee line", description: "Four operations, two stations",
    });
    expect(made.status).toBe(201);
    const t = made.body.template;

    /* The shape. */
    expect(t.stations).toHaveLength(2);
    expect(t.stations.map((s) => s.label)).toEqual(["Front", "Close"]);
    expect(t.stations[0].note).toBe("Two operators");
    expect(t.stations[0].plannedMachineTypes).toEqual([{ machineType: "SNLS", quantity: 2 }]);
    expect(t.stations[1].plannedMachineTypes).toEqual([{ machineType: "OVERLOCK", quantity: 1 }]);
    expect(t.slotCount).toBe(4);
    expect(t.status).toBe("ACTIVE");
    expect(t.revision).toBe(1);

    /* Every slot names the STABLE operation and its occurrence. */
    const slots = t.stations.flatMap((s) => s.slots);
    expect(slots.map((s) => s.ieOperationId)).toEqual(layout.source.rows.map((r) => r.ieOperationId));
    expect(slots.every((s) => s.occurrence === 1)).toBe(true);

    /* And the identity does NOT cross, anywhere in the payload. */
    const wire = JSON.stringify(t);
    for (const row of layout.source.rows) {
      expect(wire).not.toContain(row.rowId);
    }
    for (const station of layout.stations) {
      expect(wire).not.toContain(station.stationId);
    }
    expect(wire).not.toContain(layout.source.fingerprint);
    expect(t.stations.every((s) => !("stationId" in s))).toBe(true);
    expect(t.stations.flatMap((s) => s.slots).every((s) => !("rowId" in s))).toBe(true);

    /* Provenance is recorded for a person, and is not the layout's identity
       masquerading as the template's. */
    expect(t.capturedFrom.layoutId).toBe(layout.layoutId);
    expect(t.capturedFrom.bulletinRevision).toBe(layout.source.bulletinRevision);
    expect(t.templateId).not.toBe(layout.layoutId);
    expect(t.revision).not.toBe(layout.revision);
    expect(t.allocates).toBe(false);
    expect(t.canApprove).toBe(false);
  });

  test("a template station id is the template's own, and differs every time", async () => {
    const w = await world("Ids");
    const { layout } = await arranged(w);
    const a = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "First" });
    const b = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Second" });
    const idsOf = (r) => r.body.template.stations.map((s) => s.templateStationId);
    expect(new Set([...idsOf(a), ...idsOf(b)]).size).toBe(4);
    for (const id of [...idsOf(a), ...idsOf(b)]) expect(id).toMatch(/^tst_[0-9a-f]{18}$/);
  });

  test("two active templates in one company cannot share a name, however it is spelled", async () => {
    const w = await world("Names");
    const { layout } = await arranged(w);
    expect((await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Tee line" })).status).toBe(201);
    const clash = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "  tee   LINE " });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("IE_LINE_TEMPLATE_NAME_TAKEN");

    /* Another company may use it freely. */
    const other = await world("NamesOther");
    const theirs = await arranged(other);
    expect((await makeTemplate(other.maker, other, {
      layoutId: theirs.layout.layoutId, name: "Tee line",
    })).status).toBe(201);
  });

  test("a nameless template is refused", async () => {
    const w = await world("Nameless");
    const { layout } = await arranged(w);
    const res = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });
});

/* ══ 3. LIST, READ AND PAGINATION ═════════════════════════════════════════ */

describe("the register is bounded and cursor-paged", () => {
  test("a cursor walks the whole list once, newest first, with no repeats", async () => {
    const w = await world("Paging");
    const { layout } = await arranged(w);
    for (let i = 0; i < 5; i += 1) {
      const made = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: `Pattern ${i}` });
      expect(made.status).toBe(201);
    }
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const qs = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await listTemplates(w.maker, w, qs);
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(2);
      expect(res.body.sort).toBe("createdAt:desc,_id:desc");
      seen.push(...res.body.templates.map((t) => t.templateId));
      if (!res.body.hasMore) { cursor = res.body.nextCursor; break; }
      cursor = res.body.nextCursor;
      expect(cursor).toBeTruthy();
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  test("the list can be filtered by status, and refuses any other value", async () => {
    const w = await world("Filter");
    const { layout } = await arranged(w);
    const a = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Kept" });
    const b = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Dropped" });
    await retire(w.maker, w, b.body.template.templateId, { expectedRevision: 1 });

    const active = await listTemplates(w.maker, w, "?status=ACTIVE");
    expect(active.body.templates.map((t) => t.templateId)).toEqual([a.body.template.templateId]);
    const retired = await listTemplates(w.maker, w, "?status=RETIRED");
    expect(retired.body.templates.map((t) => t.templateId)).toEqual([b.body.template.templateId]);
    /* Unfiltered shows both, because a retired template is evidence. */
    expect((await listTemplates(w.maker, w)).body.templates).toHaveLength(2);

    const bad = await listTemplates(w.maker, w, "?status=DELETED");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION");
  });

  test("the list carries no history, and the read does", async () => {
    const w = await world("Shape");
    const { layout } = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: layout.layoutId, name: "Shape" });
    const listed = (await listTemplates(w.maker, w)).body.templates[0];
    expect(listed.history).toBeUndefined();
    expect(listed.stationCount).toBe(2);
    const read = await readTemplate(w.maker, w, made.body.template.templateId);
    expect(read.body.template.history).toHaveLength(1);
    expect(read.body.template.history[0].type).toBe("LINE_TEMPLATE_CREATED");
  });
});

/**
 * A layout with a DIFFERENT source from `arranged`'s, on the same file.
 *
 * Chunk 6A resumes the one draft layout per exact source, so opening the same
 * file twice returns the same record. Approving another study for one row moves
 * the source fingerprint, which supersedes the arranged layout and lets a new
 * one open — which is the real shape of this feature: a pattern captured from
 * the line that was, applied to the line that is.
 */
/**
 * A NEW empty layout, for a source that has genuinely moved on.
 *
 * CHUNK 7C2: re-approving a study no longer produces one. A layout is a balance
 * of an approved bulletin version, and the way to get a second layout is the
 * next version being approved — so that is what this does. The re-approval
 * still happens first, so the new version's frozen times really are different.
 */
async function freshTarget(w, { minutes = 1 } = {}) {
  await approveAgain(w, 0, { minutes });
  const next = await approveBulletinVersion({
    co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
  });
  w.bulletinVersion = next.version;
  w.fileRevision = next.fileRevision;
  w.fileRevisionNow = next.fileRevisionNow;

  const opened = await openLayout(w.maker, w);
  expect(opened.status).toBe(201);
  expect(opened.body.layout.stations).toEqual([]);
  return opened.body.layout;
}

/* ══ 4. APPLYING — IDENTITY ═══════════════════════════════════════════════ */

describe("applying a template lends no identity at all", () => {
  test("fresh station ids are minted, and none of the template's or the source layout's travels", async () => {
    const w = await world("Apply");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Apply pattern" });
    const template = made.body.template;

    /* A NEW layout, for a source that has moved on. */
    const before = await freshTarget(w);

    const res = await apply(w.maker, w, before.layoutId, {
      templateId: template.templateId, expectedRevision: before.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const after = res.body.layout;

    /* The pattern arrived. */
    expect(after.stations.map((s) => s.label)).toEqual(["Front", "Close"]);
    expect(after.stations[0].note).toBe("Two operators");
    expect(after.stations[0].plannedMachineTypes).toEqual([{ machineType: "SNLS", quantity: 2 }]);
    expect(after.stations.flatMap((s) => s.assignments.map((a) => a.rowId)))
      .toEqual(before.source.rows.map((r) => r.rowId));

    /* Fresh station ids: not the template's, and not the layout the template
       was captured from. */
    const applied = after.stations.map((s) => s.stationId);
    for (const id of applied) expect(id).toMatch(/^stn_[0-9a-f]{18}$/);
    for (const ts of template.stations) expect(applied).not.toContain(ts.templateStationId);
    for (const ss of source.layout.stations) expect(applied).not.toContain(ss.stationId);

    /* ── STRUCTURAL IDENTITY DOES NOT TRAVEL; PROVENANCE DELIBERATELY DOES ──
       No template station id and no slot id appears anywhere in the layout —
       those are the pattern's own structure, and borrowing them would couple
       the two records.

       The template's ID is a different matter and is RECORDED on purpose, in
       the audit event and nowhere else: a template releases its active name
       when it is retired, so two templates can share a name and the trail could
       not otherwise say which one was applied. It is provenance, not a
       reference — nothing resolves through it. */
    const wire = JSON.stringify(after);
    for (const ts of template.stations) {
      expect(wire).not.toContain(ts.templateStationId);
      for (const slot of ts.slots) expect(wire).not.toContain(slot.slotId);
    }
    const structural = JSON.stringify({ stations: after.stations, source: after.source });
    expect(structural).not.toContain(template.templateId);
    const appliedEvent = after.history.find((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(appliedEvent.templateId).toBe(template.templateId);
    expect(appliedEvent.templateRevision).toBe(template.revision);

    /* The target's OWN source identity, revision and ownership are its own. */
    expect(after.layoutId).toBe(before.layoutId);
    expect(after.source.fingerprint).toBe(before.source.fingerprint);
    expect(after.source.bulletinRevision).toBe(before.source.bulletinRevision);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.companyId).toBe(String(w.co._id));
  });

  test("applying twice mints different station ids each time", async () => {
    const w = await world("Twice");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Twice pattern" });

    const first = await openLayout(w.maker, w);
    const a = await apply(w.maker, w, first.body.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: first.body.layout.revision,
    });
    /* Rearrange, then apply again to the SAME layout. */
    const shuffled = await patchLayout(w.maker, w, a.body.layout.layoutId, {
      expectedRevision: a.body.layout.revision, stations: [],
    });
    const b = await apply(w.maker, w, shuffled.body.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: shuffled.body.layout.revision,
    });
    expect(b.status).toBe(200);
    const idsA = a.body.layout.stations.map((s) => s.stationId);
    const idsB = b.body.layout.stations.map((s) => s.stationId);
    expect(new Set([...idsA, ...idsB]).size).toBe(4);
  });

  test("the assignment's operation, name and minutes come from the TARGET, never the template", async () => {
    const w = await world("Minutes", { minutes: [1, 1.2, 0.8, 1.5] });
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Minutes pattern" });

    /* Re-approve one row at a different standard, which supersedes the old
       layout and gives a NEW layout different minutes for the same operation. */
    const target = await freshTarget(w, { minutes: 4 });
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(200);
    const first = res.body.layout.stations[0].assignments[0];
    expect(first.standardTimeMinutes).toBe(4);
    /* The template holds no minutes at all to have carried. */
    expect(JSON.stringify(made.body.template)).not.toContain("standardTimeMinutes");
  });

  test("the balance, the compatibility and the readiness are recalculated, never carried", async () => {
    const w = await world("Recalc", { minutes: [1, 1, 1, 1] });
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Recalc pattern" });
    /* The template carries no figure and no verdict at all. */
    const t = JSON.stringify(made.body.template);
    for (const forbidden of [
      "workloadMinutes", "idleMinutes", "isBottleneck", "balanceEfficiencyPercent",
      "balanceLossPercent", "pitchMinutes", "totalWorkContentMinutes",
      "machineTypeCompatibility", "readiness", "metrics",
    ]) {
      expect(t).not.toContain(forbidden);
    }

    const target = await freshTarget(w);
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    /* And the layout has them, computed by its own publisher. */
    const l = res.body.layout;
    expect(l.metrics.available).toBe(true);
    expect(l.metrics.totalWorkContentMinutes).toBe(4);
    expect(l.metrics.stationCount).toBe(2);
    expect(l.stations[0].workloadMinutes).toBe(2);
    expect(l.machineTypeCompatibility.state).toBeDefined();
    expect(l.stations[0].assignments[0].machineTypeCompatibility).toBeDefined();
    expect(l.readiness).toBeDefined();
  });

  test("one bounded history event names the template and its revision", async () => {
    const w = await world("Trail");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Trail pattern" });
    const target = await freshTarget(w);
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });

    expect(res.body.events).toHaveLength(1);
    const e = res.body.events[0];
    expect(e.type).toBe("LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(e.layoutRevision).toBe(2);
    expect(e.summary).toContain("Trail pattern");
    expect(e.summary).toContain("revision 1");
    /* One entry added to the layout's own trail, and it is not a copy of the
       template's trail. */
    expect(res.body.layout.history).toHaveLength(2);
    expect(res.body.layout.history[0].type).toBe("LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(JSON.stringify(res.body.layout.history)).not.toContain("LINE_TEMPLATE_CREATED");
  });
});

/* ══ 5. STABLE OPERATION MATCHING ═════════════════════════════════════════ */

describe("a slot resolves through the stable operation, never the code", () => {
  test("a renamed operation code still resolves", async () => {
    const w = await world("Rename");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Rename pattern" });

    /* The code moves. The stable id does not. */
    const op = w.operations[0];
    const renamed = await call(`/operations/library/${op.operationId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: op.revision, code: "TOTALLY-DIFFERENT" },
    });
    expect(renamed.status).toBe(200);

    const target = await freshTarget(w);
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.layout.stations.flatMap((s) => s.assignments)).toHaveLength(4);
  });

  test("another company's identically coded operation is never matched", async () => {
    const mine = await world("CodeMine");
    const theirs = await world("CodeTheirs");
    /* Both companies have operations coded OP-1..OP-4 — `world` builds them
       that way — so a code-matching implementation would resolve across the
       boundary. The stable id cannot. */
    expect(mine.operations[0].code).toBe(theirs.operations[0].code);

    const source = await arranged(mine);
    const made = await makeTemplate(mine.maker, mine, {
      layoutId: source.layout.layoutId, name: "Code pattern",
    });
    const slotIds = made.body.template.stations.flatMap((s) => s.slots.map((x) => x.ieOperationId));
    for (const theirOp of theirs.operations) {
      expect(slotIds).not.toContain(theirOp.operationId);
    }
  });

  test("the service holds no code-matching path at all", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "industrialEngineering", "ieLineTemplate.service.js"),
      "utf8",
    );
    /* `operationCode` is captured for display. It may never be READ back as a
       key, so no lookup structure is built from it. */
    expect(src).not.toMatch(/byCode|codeIndex|get\(\s*\w*[Cc]ode/);
    expect(src).not.toMatch(/operationCode\s*===/);
    expect(src).not.toMatch(/upperType\(\s*\w+\.operationCode/);
  });
});

describe("the same operation placed twice is told apart deterministically", () => {
  /** A bulletin that places operation 1 three times and operation 2 once. */
  async function repeated(name) {
    const w = await world(name, { minutes: [1, 1, 1, 1] });
    const t = { token: w.maker.token, company: w.co._id };
    const file = (await call(`/orders/${w.workOrder._id}/styles/${w.style._id}/engineering-file`, { ...t })).body.file;
    /* Re-author the bulletin: OP-1, OP-2, OP-1, OP-1. */
    const patched = await call(`/engineering-files/${w.fileId}/bulletin`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: file.revision,
        rows: [
          { ieOperationId: w.operations[0].operationId, proposedSamMinutes: 1 },
          { ieOperationId: w.operations[1].operationId, proposedSamMinutes: 1 },
          { ieOperationId: w.operations[0].operationId, proposedSamMinutes: 1 },
          { ieOperationId: w.operations[0].operationId, proposedSamMinutes: 1 },
        ],
      },
    });
    expect(patched.status).toBe(200);
    const rows = patched.body.file.bulletin.rows;
    /* Approve a standard for every row. */
    for (const row of rows) {
      const opened = await call(`/engineering-files/${w.fileId}/bulletin/${row.rowId}/method-studies`, {
        method: "POST", ...t, body: {},
      });
      if (opened.status !== 201 && opened.status !== 200) continue;
      const studyId = opened.body.study.studyId;
      const filled = await call(`/method-studies/${studyId}`, {
        method: "PATCH", ...t,
        body: {
          expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "L",
          methodNote: "M", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
        },
      });
      const submitted = await call(`/method-studies/${studyId}/submit`, {
        method: "POST", ...t,
        body: {
          expectedRevision: filled.body.study.revision,
          manualStandardTimeMinutes: 1, overrideReason: "Fixed for this exercise.",
        },
      });
      await call(`/method-studies/${studyId}/approve`, {
        method: "POST", token: w.approver.token, company: w.co._id,
        body: { expectedRevision: submitted.body.study.revision },
      });
    }
    /* CHUNK 7C2: this purpose-built bulletin is what the layout must balance,
       so it is submitted and approved as the next version. Without that, the
       layout would still be opened against the world's original version and
       would carry four distinct operations rather than three of one. */
    const next = await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
    });
    w.bulletinVersion = next.version;
    w.fileRevision = next.fileRevision;
    w.fileRevisionNow = next.fileRevisionNow;
    return { w, rows };
  }

  test("occurrence is counted in source order, and each one keeps its own station", async () => {
    const { w } = await repeated("Repeat");
    const opened = await openLayout(w.maker, w);
    expect(opened.status).toBe(201);
    const layout = opened.body.layout;
    const rows = layout.source.rows;
    expect(rows).toHaveLength(4);

    /* Put the three OP-1 occurrences at three different stations, in a
       deliberately non-obvious order. */
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [
        { label: "Third", assignments: [{ rowId: rows[3].rowId }] },
        { label: "First", assignments: [{ rowId: rows[0].rowId }] },
        { label: "Other", assignments: [{ rowId: rows[1].rowId }] },
        { label: "Second", assignments: [{ rowId: rows[2].rowId }] },
      ],
    });
    expect(saved.status).toBe(200);

    const made = await makeTemplate(w.maker, w, {
      layoutId: saved.body.layout.layoutId, name: "Repeat pattern",
    });
    const slots = made.body.template.stations.map((s) => ({ label: s.label, slot: s.slots[0] }));
    /* Occurrence follows the SOURCE order, not the station order. */
    expect(slots.map((x) => `${x.label}:${x.slot.occurrence}`))
      .toEqual(["Third:3", "First:1", "Other:1", "Second:2"]);

    /* Applying to a fresh layout puts each occurrence back where it belonged. */
    const target = await openLayout(w.maker, w);
    const res = await apply(w.maker, w, target.body.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.body.layout.revision,
    });
    expect(res.status).toBe(200);
    const targetRows = target.body.layout.source.rows;
    expect(res.body.layout.stations.map((s) => ({
      label: s.label, rowId: s.assignments[0].rowId,
    }))).toEqual([
      { label: "Third", rowId: targetRows[3].rowId },
      { label: "First", rowId: targetRows[0].rowId },
      { label: "Other", rowId: targetRows[1].rowId },
      { label: "Second", rowId: targetRows[2].rowId },
    ]);
    /* Every row placed exactly once. */
    const placed = res.body.layout.stations.flatMap((s) => s.assignments.map((a) => a.rowId));
    expect(new Set(placed).size).toBe(4);
  });

  test("the occurrence rule is a pure function of source order", () => {
    const { occurrenceIndexOf } = require("../../services/industrialEngineering/ieLineTemplate.service");
    const opA = new mongoose.Types.ObjectId();
    const opB = new mongoose.Types.ObjectId();
    /* Deliberately out of order, to prove it sorts by `sequence`. */
    const rows = [
      { rowId: "r3", sequence: 3, ieOperationId: opA },
      { rowId: "r1", sequence: 1, ieOperationId: opA },
      { rowId: "r2", sequence: 2, ieOperationId: opB },
      { rowId: "r4", sequence: 4, ieOperationId: opA },
    ];
    const { byRow, byOperation, counts } = occurrenceIndexOf(rows);
    expect(byRow.get("r1").occurrence).toBe(1);
    expect(byRow.get("r3").occurrence).toBe(2);
    expect(byRow.get("r4").occurrence).toBe(3);
    expect(byRow.get("r2").occurrence).toBe(1);
    expect(counts.get(String(opA))).toBe(3);
    expect(byOperation.get(String(opA)).get(2).rowId).toBe("r3");
    /* Same input, same answer, whatever order it arrives in. */
    const shuffled = occurrenceIndexOf([...rows].reverse());
    expect([...shuffled.byRow].map(([k, v]) => `${k}:${v.occurrence}`).sort())
      .toEqual([...byRow].map(([k, v]) => `${k}:${v.occurrence}`).sort());
  });
});

/* ══ 6. A PATTERN THAT DOES NOT FIT ═══════════════════════════════════════ */

describe("a template that half-fits is refused whole", () => {
  /** A second style in the same company, with only two of the four operations. */
  async function shorterSource(w) {
    const t = { token: w.maker.token, company: w.co._id };
    const n = Math.floor(Math.random() * 1e9);
    const item = await StockItem.create({
      name: `Short ${n}`, sku: `SKU-SH-${n}`, reference: `REF-SH-${n}`, category: "Garment",
      createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 10,
      variants: [{ sku: `VAR-SH-${n}`, cost: 0, salesPrice: 0 }],
    });
    const wo = await WorkOrder.create({
      workOrderNumber: `WO-SH-${n}`, stockItemId: item._id, stockItemName: item.name,
      stockItemReference: item.reference, quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    });
    const style = await SampleStyle.create({
      sampleStyleId: `SS-SH-${n}`, productName: `Short ${n}`, styleCode: `ST-SH-${n}`,
      variantLabel: "Navy", journeyId: w.style.journeyId, enquiryId: w.style.enquiryId,
      sourceStockItemId: item._id, materials: { status: "pending", rawItems: [] },
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
    const file = (await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
      method: "POST", ...t, body: {},
    })).body.file;
    /* Only the FIRST TWO operations. */
    const patched = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: file.revision,
        rows: w.operations.slice(0, 2).map((op) => ({ ieOperationId: op.operationId, proposedSamMinutes: 1 })),
      },
    });
    for (const row of patched.body.file.bulletin.rows) {
      const opened = await call(`/engineering-files/${file.fileId}/bulletin/${row.rowId}/method-studies`, {
        method: "POST", ...t, body: {},
      });
      const studyId = opened.body.study.studyId;
      const filled = await call(`/method-studies/${studyId}`, {
        method: "PATCH", ...t,
        body: {
          expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "L",
          methodNote: "M", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
        },
      });
      const submitted = await call(`/method-studies/${studyId}/submit`, {
        method: "POST", ...t,
        body: {
          expectedRevision: filled.body.study.revision,
          manualStandardTimeMinutes: 1, overrideReason: "Fixed for this exercise.",
        },
      });
      await call(`/method-studies/${studyId}/approve`, {
        method: "POST", token: w.approver.token, company: w.co._id,
        body: { expectedRevision: submitted.body.study.revision },
      });
    }
    /* CHUNK 7C2: a layout is opened against an APPROVED bulletin version, so
       this purpose-built bulletin has to be submitted and approved first. */
    await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: file.fileId,
    });
    const opened = await call(`/engineering-files/${file.fileId}/line-layouts`, {
      method: "POST", ...t, body: {},
    });
    expect(opened.status).toBe(201);
    return opened.body.layout;
  }

  test("every missing slot is named, and nothing at all is written", async () => {
    const w = await world("Missing");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Four station" });
    const target = await shorterSource(w);

    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_SLOT_NOT_IN_SOURCE");

    /* Both unresolvable slots, each with what it is and why. */
    const missing = res.body.error.details.missingSlots;
    expect(missing).toHaveLength(2);
    expect(missing.map((m) => m.ieOperationId).sort())
      .toEqual(w.operations.slice(2).map((o) => o.operationId).sort());
    for (const m of missing) {
      expect(m.reason).toBe("OPERATION_NOT_IN_SOURCE");
      expect(m.availableOccurrences).toBe(0);
      expect(m.occurrence).toBe(1);
      expect(m.operationCode).toMatch(/^OP-/);
      expect(m.templateStationLabel).toBe("Close");
    }
    expect(res.body.error.details.templateId).toBe(made.body.template.templateId);
    expect(res.body.error.details.templateRevision).toBe(1);

    /* NOTHING moved: no station, no revision, no history, no timestamp. */
    const after = await readLayout(w.maker, w, target.layoutId);
    expect(after.body.layout.stations).toEqual([]);
    expect(after.body.layout.revision).toBe(target.revision);
    expect(after.body.layout.history).toHaveLength(1);
    expect(after.body.layout.updatedAt).toBe(target.updatedAt);
  });

  test("too FEW occurrences is its own reason, and is equally atomic", async () => {
    const w = await world("Fewer");
    const t = { token: w.maker.token, company: w.co._id };
    /* A pattern that wants the SECOND occurrence of operation 1. */
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Fewer pattern" });
    const opId = w.operations[0].operationId;
    const edited = await patchTemplate(w.maker, w, made.body.template.templateId, {
      expectedRevision: 1,
      stations: [{ label: "Only", slots: [{ ieOperationId: opId, occurrence: 2 }] }],
    });
    expect(edited.status).toBe(200);

    const target = await freshTarget(w);
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(409);
    const missing = res.body.error.details.missingSlots;
    expect(missing).toHaveLength(1);
    expect(missing[0].reason).toBe("FEWER_OCCURRENCES_IN_SOURCE");
    expect(missing[0].availableOccurrences).toBe(1);
    expect(missing[0].occurrence).toBe(2);

    const after = await readLayout(w.maker, w, target.layoutId);
    expect(after.body.layout.revision).toBe(target.revision);
    expect(after.body.layout.stations).toEqual([]);
  });

  test("rows the template does not place stay unassigned, and show as a coverage gap", async () => {
    const w = await world("Partial");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Partial pattern" });
    /* A pattern that places only the first two operations. */
    const trimmed = await patchTemplate(w.maker, w, made.body.template.templateId, {
      expectedRevision: 1,
      stations: [{
        label: "Front", plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }],
        slots: [
          { ieOperationId: w.operations[0].operationId, occurrence: 1 },
          { ieOperationId: w.operations[1].operationId, occurrence: 1 },
        ],
      }],
    });
    expect(trimmed.status).toBe(200);

    const target = await freshTarget(w);
    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.layout.stations).toHaveLength(1);
    expect(res.body.layout.stations[0].assignments).toHaveLength(2);

    /* The other two are unassigned, and the EXISTING readiness calculation
       reports them — nothing new was invented for this. */
    const gap = res.body.layout.readiness.gaps.find((g) => g.code === "IE_LAYOUT_ROWS_UNASSIGNED");
    expect(gap).toBeDefined();
    expect(gap.rowIds).toHaveLength(2);
    expect(gap.rowIds.sort()).toEqual(target.source.rows.slice(2).map((r) => r.rowId).sort());
    expect(res.body.layout.readiness.ready).toBe(false);
  });
});

/* ══ 7. CONCURRENCY, LIFECYCLE AND INDEPENDENCE ═══════════════════════════ */

describe("every refusal is atomic and every conflict is typed", () => {
  test("a layout revision conflict refuses the application and writes nothing", async () => {
    const w = await world("LayoutRev");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Rev pattern" });
    const target = await freshTarget(w);

    const res = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision + 5,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(res.body.error.details.expected).toBe(target.revision + 5);
    expect(res.body.error.details.actual).toBe(target.revision);

    const after = await readLayout(w.maker, w, target.layoutId);
    expect(after.body.layout.revision).toBe(target.revision);
    expect(after.body.layout.history).toHaveLength(1);
  });

  test("a superseded layout cannot have a template applied to it", async () => {
    const w = await world("Stale");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Stale pattern" });
    /* CHUNK 7C2: a layout is superseded when the bulletin version it balances
       is, which happens when the NEXT version is approved. Re-approving a study
       alone no longer reaches a layout — that is the whole point of binding one
       to an immutable version. */
    await approveAgain(w, 0, { minutes: 3 });
    await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
    });

    const res = await apply(w.maker, w, source.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: source.layout.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_LAYOUT_SOURCE_CHANGED");
    expect(res.body.error.details.resolution).toBe("OPEN_NEW_LAYOUT");

    const after = await readLayout(w.maker, w, source.layout.layoutId);
    expect(after.body.layout.revision).toBe(source.layout.revision);
    expect(after.body.layout.source.state).toBe("SOURCE_CHANGED");
  });

  test("a template revision conflict refuses the edit and writes nothing", async () => {
    const w = await world("TplRev");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "TplRev pattern" });
    const id = made.body.template.templateId;
    const res = await patchTemplate(w.maker, w, id, { expectedRevision: 9, name: "Renamed" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_REVISION_CONFLICT");
    expect(res.body.error.details.actual).toBe(1);

    const after = await readTemplate(w.maker, w, id);
    expect(after.body.template.name).toBe("TplRev pattern");
    expect(after.body.template.revision).toBe(1);
    expect(after.body.template.history).toHaveLength(1);
  });

  test("an edit that changes nothing is an honest no-op", async () => {
    const w = await world("TplNoop");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Noop pattern" });
    const id = made.body.template.templateId;
    const res = await patchTemplate(w.maker, w, id, { expectedRevision: 1, name: "Noop pattern" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.template.revision).toBe(1);
    expect(res.body.template.history).toHaveLength(1);
  });

  test("applying the same pattern twice moves nothing the second time", async () => {
    const w = await world("ApplyNoop");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Noop apply" });
    const target = await freshTarget(w);

    const first = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    expect(first.body.updated).toBe(true);
    const afterFirst = first.body.layout;

    const second = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: afterFirst.revision,
    });
    expect(second.status).toBe(200);
    expect(second.body.updated).toBe(false);
    expect(second.body.events).toEqual([]);
    expect(second.body.layout.revision).toBe(afterFirst.revision);
    expect(second.body.layout.history).toHaveLength(afterFirst.history.length);
    /* Even the station ids are untouched — nothing was re-minted. */
    expect(second.body.layout.stations.map((s) => s.stationId))
      .toEqual(afterFirst.stations.map((s) => s.stationId));
    expect(second.body.layout.updatedAt).toBe(afterFirst.updatedAt);
  });

  test("retire and restore are reversible, and nothing is ever deleted", async () => {
    const w = await world("Lifecycle");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Lifecycle pattern" });
    const id = made.body.template.templateId;

    const retired = await retire(w.maker, w, id, { expectedRevision: 1 });
    expect(retired.status).toBe(200);
    expect(retired.body.template.status).toBe("RETIRED");
    expect(retired.body.template.revision).toBe(2);
    expect(retired.body.template.editable).toBe(false);
    expect(retired.body.template.history[0].type).toBe("LINE_TEMPLATE_RETIRED");
    /* The record is still there, in full. */
    expect(await IeLineTemplate.countDocuments({ _id: id })).toBe(1);
    expect((await readTemplate(w.maker, w, id)).body.template.stations).toHaveLength(2);

    /* A retired template is not edited and not applied. */
    const edit = await patchTemplate(w.maker, w, id, { expectedRevision: 2, name: "Nope" });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("IE_LINE_TEMPLATE_RETIRED");
    const target = await freshTarget(w);
    const applied = await apply(w.maker, w, target.layoutId, { templateId: id, expectedRevision: target.revision });
    expect(applied.status).toBe(409);
    expect(applied.body.error.code).toBe("IE_LINE_TEMPLATE_RETIRED");
    expect((await readLayout(w.maker, w, target.layoutId)).body.layout.revision).toBe(target.revision);

    /* Restoring brings it back, unchanged. */
    const restored = await restore(w.maker, w, id, { expectedRevision: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.template.status).toBe("ACTIVE");
    expect(restored.body.template.revision).toBe(3);
    expect(restored.body.template.stations).toHaveLength(2);

    /* And each refuses the state it is already in. */
    expect((await restore(w.maker, w, id, { expectedRevision: 3 })).body.error.code)
      .toBe("IE_LINE_TEMPLATE_ALREADY_ACTIVE");
    await retire(w.maker, w, id, { expectedRevision: 3 });
    expect((await retire(w.maker, w, id, { expectedRevision: 4 })).body.error.code)
      .toBe("IE_LINE_TEMPLATE_ALREADY_RETIRED");
  });

  test("retiring releases the name, and restoring into a taken one is refused", async () => {
    const w = await world("NameRelease");
    const source = await arranged(w);
    const a = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Shared name" });
    await retire(w.maker, w, a.body.template.templateId, { expectedRevision: 1 });

    /* The name is free again. */
    const b = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Shared name" });
    expect(b.status).toBe(201);

    /* So restoring the first is refused, with the resolution named. */
    const res = await restore(w.maker, w, a.body.template.templateId, { expectedRevision: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_NAME_TAKEN");
    expect(res.body.error.details.resolution).toBe("RETIRE_CONFLICTING_THEN_RESTORE");
    /* And nothing moved. */
    const after = await readTemplate(w.maker, w, a.body.template.templateId);
    expect(after.body.template.status).toBe("RETIRED");
    expect(after.body.template.revision).toBe(2);
  });

  test("there is no DELETE anywhere on the template surface", async () => {
    const w = await world("NoDelete");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Kept for ever" });
    const id = made.body.template.templateId;
    for (const path of ["/line-templates", `/line-templates/${id}`]) {
      const res = await call(path, { method: "DELETE", token: w.maker.token, company: w.co._id });
      expect([404, 405]).toContain(res.status);
    }
    expect(await IeLineTemplate.countDocuments({ _id: id })).toBe(1);
  });
});

describe("a template and the layouts made from it are independent for ever", () => {
  test("editing the template changes no layout already made from it", async () => {
    const w = await world("Independent");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Independent pattern" });
    const target = await freshTarget(w);
    const applied = await apply(w.maker, w, target.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.revision,
    });
    const snapshot = applied.body.layout;

    /* Rewrite the template completely. */
    const edited = await patchTemplate(w.maker, w, made.body.template.templateId, {
      expectedRevision: 1, name: "Rewritten",
      stations: [{
        label: "One big station", note: "Everything here",
        plannedMachineTypes: [{ machineType: "BARTACK", quantity: 9 }],
        slots: w.operations.map((op) => ({ ieOperationId: op.operationId, occurrence: 1 })),
      }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.template.revision).toBe(2);

    /* The layout has not moved at all. */
    const after = await readLayout(w.maker, w, target.layoutId);
    expect(after.body.layout.revision).toBe(snapshot.revision);
    expect(after.body.layout.stations.map((s) => s.label)).toEqual(["Front", "Close"]);
    expect(after.body.layout.stations[0].plannedMachineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 2 }]);
    expect(after.body.layout.history).toHaveLength(snapshot.history.length);

    /* And retiring it does not either. */
    await retire(w.maker, w, made.body.template.templateId, { expectedRevision: 2 });
    const stillThere = await readLayout(w.maker, w, target.layoutId);
    expect(stillThere.body.layout.revision).toBe(snapshot.revision);
    expect(stillThere.body.layout.stations).toHaveLength(2);
  });

  test("editing a layout changes no template captured from it", async () => {
    const w = await world("Reverse");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Reverse pattern" });
    const before = made.body.template;

    /* Rearrange the layout the template came from, completely. */
    const rearranged = await patchLayout(w.maker, w, source.layout.layoutId, {
      expectedRevision: source.layout.revision,
      stations: [{
        label: "Everything", note: "Changed",
        plannedMachineTypes: [{ machineType: "BARTACK", quantity: 1 }],
        assignments: source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(rearranged.status).toBe(200);

    const after = await readTemplate(w.maker, w, before.templateId);
    expect(after.body.template.revision).toBe(before.revision);
    expect(after.body.template.stations.map((s) => s.label)).toEqual(["Front", "Close"]);
    expect(after.body.template.stations[0].plannedMachineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 2 }]);
    expect(after.body.template.history).toHaveLength(1);
  });

  test("a template survives its source layout being superseded", async () => {
    const w = await world("Survive");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Survive pattern" });
    await approveAgain(w, 1, { minutes: 7 });
    await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
    });

    const superseded = await readLayout(w.maker, w, source.layout.layoutId);
    expect(superseded.body.layout.source.state).toBe("SOURCE_CHANGED");

    /* The template is unchanged and still applies. */
    const after = await readTemplate(w.maker, w, made.body.template.templateId);
    expect(after.body.template.status).toBe("ACTIVE");
    expect(after.body.template.stations).toHaveLength(2);
    const target = await openLayout(w.maker, w);
    const res = await apply(w.maker, w, target.body.layout.layoutId, {
      templateId: made.body.template.templateId, expectedRevision: target.body.layout.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
  });
});

/* ══ 8. THE PRODUCTION BOUNDARY ═══════════════════════════════════════════ */

describe("nothing here reaches Production, a machine, a scan or a person", () => {
  const fs = require("fs");
  const path = require("path");
  const svc = fs.readFileSync(
    path.join(__dirname, "..", "..", "services", "industrialEngineering", "ieLineTemplate.service.js"), "utf8",
  );
  const model = fs.readFileSync(
    path.join(__dirname, "..", "..", "models", "CMS_Models", "IndustrialEngineering", "IeLineTemplate.js"), "utf8",
  );

  test("the service and the model require nothing outside IE's own boundary", () => {
    const requires = [...svc.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const r of requires) {
      expect(r).not.toMatch(/Machine|Production|WorkOrder|Barcode|Scan|Employee|Maintenance|Attendance|Payroll/i);
    }
    /* And exactly the IE records it needs — `IeOperation` joined them with the
       correction that proves an edited slot's operation belongs to this
       company, which is inside IE's own boundary like the rest. */
    expect(requires.filter((r) => r.includes("models/"))).toEqual([
      "../../models/CMS_Models/IndustrialEngineering/IeLineTemplate",
      "../../models/CMS_Models/IndustrialEngineering/IeLineLayout",
      "../../models/CMS_Models/IndustrialEngineering/IeStyleFile",
      "../../models/CMS_Models/IndustrialEngineering/IeOperation",
    ]);
    expect(model).not.toMatch(/require\([^)]*(Machine|Production|WorkOrder|Employee)/i);
  });

  test("the record cannot express an allocation, a person, a shift or a capacity", () => {
    /* Every one of these is refused BY NAME on the way in, with where the fact
       actually lives — not silently dropped. */
    const { REFUSED_FIELDS } = require("../../services/industrialEngineering/ieLineTemplate.service");
    for (const field of [
      "machineId", "serialNumber", "assetId", "availability", "maintenanceStatus",
      "employeeId", "employeeName", "operatorId", "shift", "capacity", "targetOutput",
      "barcodeId", "scanId", "approvedAt", "releasedAt",
    ]) {
      expect(REFUSED_FIELDS[field]).toBeTruthy();
    }
    /* And the schema has no field any of them could be written into. */
    const paths = Object.keys(IeLineTemplate.schema.paths);
    const wire = JSON.stringify(paths) + JSON.stringify(Object.keys(
      IeLineTemplate.schema.path("stations").schema.paths,
    ));
    for (const forbidden of ["machineId", "serialNumber", "employee", "operator", "shift", "capacity", "barcode", "scan"]) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("the router adds no approve, release, allocate or capacity verb", () => {
    const routes = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "IndustrialEngineering", "ieRoutes.js"), "utf8",
    );
    const templateRoutes = [...routes.matchAll(/router\.(get|post|patch|put|delete)\("([^"]*line-template[^"]*)"/g)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
    expect(templateRoutes.sort()).toEqual([
      "GET /line-templates",
      "GET /line-templates/:templateId",
      "PATCH /line-templates/:templateId",
      "POST /line-templates",
      "POST /line-templates/:templateId/restore",
      "POST /line-templates/:templateId/retire",
    ]);
    for (const verb of ["approve", "release", "allocate", "capacity", "scan", "barcode"]) {
      expect(routes).not.toMatch(new RegExp(`line-templates[^"]*${verb}`, "i"));
    }
    /* And there is still no DELETE anywhere on the router. */
    expect(routes).not.toMatch(/router\.delete\(/);
  });

  test("a template never carries a planned machine as an allocation", async () => {
    const w = await world("Plan");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Plan pattern" });
    for (const s of made.body.template.stations) {
      for (const m of s.plannedMachineTypes) {
        expect(Object.keys(m).sort()).toEqual(["machineType", "quantity"]);
      }
    }
    expect(made.body.template.allocates).toBe(false);
    expect(made.body.template.canApprove).toBe(false);
  });
});

/* ══ 9. THE THREE CORRECTIONS, AND THE CONCURRENCY PROOF ══════════════════
 *
 * Codex found three integrity defects in the first Chunk 6C delivery, and one
 * admitted test gap. Each is pinned here.
 */

describe("the applied event carries the template's stable identity", () => {
  test("templateId and templateRevision are stored and published, and null elsewhere", async () => {
    const w = await world("EventIdentity");
    const source = await arranged(w);
    const made = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Identity pattern" });
    const template = made.body.template;
    const target = await freshTarget(w);

    const res = await apply(w.maker, w, target.layoutId, {
      templateId: template.templateId, expectedRevision: target.revision,
    });
    expect(res.status).toBe(200);

    /* On the request's own `events`… */
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "LINE_LAYOUT_TEMPLATE_APPLIED",
      templateId: template.templateId,
      templateRevision: template.revision,
    });
    /* …on the layout history it returns… */
    const applied = res.body.layout.history.find((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(applied.templateId).toBe(template.templateId);
    expect(applied.templateRevision).toBe(template.revision);
    /* …and null on every other event type. */
    for (const other of res.body.layout.history.filter((e) => e.type !== "LINE_LAYOUT_TEMPLATE_APPLIED")) {
      expect(other.templateId).toBeNull();
      expect(other.templateRevision).toBeNull();
    }
    /* Stored, not merely published. */
    const stored = await IeLineLayout.findById(target.layoutId).lean();
    const event = stored.history.find((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(String(event.templateId)).toBe(template.templateId);
    expect(event.templateRevision).toBe(template.revision);
  });

  test("two templates that reused one name stay distinguishable by id", async () => {
    /* A retired template releases its active name, so the name alone cannot say
       which was applied — this is the case the free-text summary could not
       answer. */
    const w = await world("NameReuse");
    const source = await arranged(w);
    const first = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Line A" })).body.template;

    const targetOne = await freshTarget(w);
    const appliedFirst = await apply(w.maker, w, targetOne.layoutId, {
      templateId: first.templateId, expectedRevision: targetOne.revision,
    });
    expect(appliedFirst.status).toBe(200);

    /* Retire it and make a NEW template with the very same name. */
    expect((await retire(w.maker, w, first.templateId, { expectedRevision: first.revision })).status).toBe(200);
    const second = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Line A" })).body.template;
    expect(second.name).toBe(first.name);
    expect(second.templateId).not.toBe(first.templateId);

    const targetTwo = await freshTarget(w, { minutes: 1.4 });
    const appliedSecond = await apply(w.maker, w, targetTwo.layoutId, {
      templateId: second.templateId, expectedRevision: targetTwo.revision,
    });
    expect(appliedSecond.status).toBe(200);

    /* Same name in both summaries; different ids in the structured fields. */
    const one = appliedFirst.body.events[0];
    const two = appliedSecond.body.events[0];
    expect(one.summary).toContain("Line A");
    expect(two.summary).toContain("Line A");
    expect(one.templateId).toBe(first.templateId);
    expect(two.templateId).toBe(second.templateId);
    expect(one.templateId).not.toBe(two.templateId);
  });

  test("renaming, editing or retiring the template afterwards does not touch the event", async () => {
    const w = await world("EventFrozen");
    const source = await arranged(w);
    const template = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Before rename" })).body.template;
    const target = await freshTarget(w);
    const applied = await apply(w.maker, w, target.layoutId, {
      templateId: template.templateId, expectedRevision: target.revision,
    });
    const event = applied.body.events[0];

    const renamed = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision, name: "After rename", description: "changed",
    });
    expect(renamed.status).toBe(200);
    expect((await retire(w.maker, w, template.templateId, { expectedRevision: renamed.body.template.revision })).status).toBe(200);

    const after = await readLayout(w.maker, w, target.layoutId);
    const stillThere = after.body.layout.history.find((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(stillThere.templateId).toBe(template.templateId);
    expect(stillThere.templateRevision).toBe(template.revision);
    expect(stillThere.templateId).toBe(event.templateId);
    expect(stillThere.templateRevision).toBe(event.templateRevision);
    /* The event says what it said on the day — including the old name. */
    expect(stillThere.summary).toContain("Before rename");
    expect(stillThere.summary).not.toContain("After rename");
    expect(after.body.layout.revision).toBe(applied.body.layout.revision);
  });
});

describe("an edited slot's operation must be this company's", () => {
  async function editable(name) {
    const w = await world(name);
    const source = await arranged(w);
    const template = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: `${name} pattern` })).body.template;
    return { w, template, source };
  }
  const patternOf = (template, override) => template.stations.map((s, i) => ({
    label: s.label, note: s.note,
    plannedMachineTypes: s.plannedMachineTypes.map((m) => ({ machineType: m.machineType, quantity: m.quantity })),
    slots: s.slots.map((slot, j) => ({
      ieOperationId: (i === 0 && j === 0 && override) ? override : slot.ieOperationId,
      occurrence: slot.occurrence,
    })),
  }));

  test("a foreign operation and one that never existed are refused identically", async () => {
    const { w, template } = await editable("ForeignSlot");
    const theirs = await world("TheirLibrary");
    const theirOperation = theirs.operations[0].operationId;
    const before = await IeLineTemplate.findById(template.templateId).lean();

    const foreign = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision, stations: patternOf(template, theirOperation),
    });
    const invented = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision, stations: patternOf(template, String(new mongoose.Types.ObjectId())),
    });

    for (const res of [foreign, invented]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_LINE_TEMPLATE_SLOT_OPERATION_NOT_FOUND");
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "stations.0.slots.0.ieOperationId", code: "UNKNOWN_OPERATION",
      });
    }
    /* Identical answers: nothing says whether the foreign one exists. */
    expect(foreign.body.error.message).toBe(invented.body.error.message);
    expect(JSON.stringify(foreign.body)).not.toMatch(/OP-1|Operation 1|TheirLibrary/);

    /* No write, no revision, no timestamp, no trail entry. */
    const after = await IeLineTemplate.findById(template.templateId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
    expect(after.stations).toEqual(before.stations);
  });

  test("every bad slot is named, and a company-owned one is accepted", async () => {
    const { w, template } = await editable("ManyBadSlots");
    const bad = [0, 1, 2, 3].map(() => String(new mongoose.Types.ObjectId()));
    let n = 0;
    const stations = template.stations.map((s) => ({
      label: s.label, note: s.note,
      plannedMachineTypes: s.plannedMachineTypes.map((m) => ({ machineType: m.machineType, quantity: m.quantity })),
      slots: s.slots.map((slot) => ({ ieOperationId: bad[n++], occurrence: slot.occurrence })),
    }));
    const res = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision, stations,
    });
    expect(res.status).toBe(400);
    /* One field error per affected slot — four slots, four errors. */
    expect(res.body.error.details.fieldErrors).toHaveLength(4);
    expect(res.body.error.details.fieldErrors.map((e) => e.field)).toEqual([
      "stations.0.slots.0.ieOperationId", "stations.0.slots.1.ieOperationId",
      "stations.1.slots.0.ieOperationId", "stations.1.slots.1.ieOperationId",
    ]);
    expect(res.body.error.details.ieOperationIds).toEqual(bad);

    /* The company's own operation is accepted, and its labels come from the
       library rather than from the caller or the previous revision. */
    const fresh = (await call("/operations/library", {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { code: "OP-NEW", name: "Newly added", machineType: "SNLS" },
    })).body.operation;
    const ok = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision,
      stations: patternOf(template, fresh.operationId),
    });
    expect(ok.status).toBe(200);
    const slot = ok.body.template.stations[0].slots[0];
    expect(slot.ieOperationId).toBe(fresh.operationId);
    expect(slot.operationCode).toBe("OP-NEW");
    expect(slot.operationName).toBe("Newly added");
  });

  test("display labels are never taken from the caller or the previous revision", async () => {
    const { w, template } = await editable("Labels");
    /* Rename the operation in the library, then re-save the same pattern: the
       labels must follow the proved record, not the stale copy. */
    const renamed = await call(`/operations/library/${w.operations[0].operationId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { name: "Renamed in library", expectedRevision: w.operations[0].revision },
    });
    expect(renamed.status).toBe(200);

    const res = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision,
      stations: patternOf(template).map((s, i) => (i === 0 ? { ...s, label: "Front B" } : s)),
    });
    expect(res.status).toBe(200);
    const first = res.body.template.stations[0].slots[0];
    expect(first.operationName).toBe("Renamed in library");
    /* And a caller cannot dictate them: the field is not part of a slot. */
    const refused = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: res.body.template.revision,
      stations: patternOf(template).map((s, i) => (i === 0
        ? { ...s, slots: s.slots.map((x, j) => (j === 0 ? { ...x, operationCode: "FAKE" } : x)) }
        : s)),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("FIELD_NOT_ACCEPTED");
  });

  test("a retired company operation is still a valid slot", async () => {
    /* The library keeps a retired operation readable and referable — bulletins
       and studies point at retired operations by design. A pattern naming one
       is a plan that will surface as a gap, not a forgery. */
    const { w, template } = await editable("RetiredSlot");
    const op = w.operations[0];
    const retiredOp = await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: { expectedRevision: op.revision },
    });
    expect(retiredOp.status).toBe(200);

    const res = await patchTemplate(w.maker, w, template.templateId, {
      expectedRevision: template.revision,
      stations: patternOf(template).map((s, i) => (i === 0 ? { ...s, label: "Front C" } : s)),
    });
    expect(res.status).toBe(200);
    expect(res.body.template.revision).toBe(template.revision + 1);
    expect(res.body.template.stations[0].slots[0].ieOperationId).toBe(op.operationId);
  });
});

describe("oversized metadata is refused, never truncated", () => {
  test("on create, both fields, with no record written", async () => {
    const w = await world("OversizeCreate");
    const source = await arranged(w);
    const before = await IeLineTemplate.countDocuments({});

    const longName = "N".repeat(161);
    const byName = await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: longName });
    expect(byName.status).toBe(400);
    expect(byName.body.error.code).toBe("VALIDATION");
    expect(byName.body.error.details.fieldErrors[0]).toMatchObject({ field: "name", code: "TOO_LONG" });

    const byDescription = await makeTemplate(w.maker, w, {
      layoutId: source.layout.layoutId, name: "Fine", description: "D".repeat(1001),
    });
    expect(byDescription.status).toBe(400);
    expect(byDescription.body.error.details.fieldErrors[0]).toMatchObject({ field: "description", code: "TOO_LONG" });

    /* Nothing was stored, and nothing was clipped to the limit. */
    expect(await IeLineTemplate.countDocuments({})).toBe(before);
    expect(await IeLineTemplate.findOne({ name: longName.slice(0, 160) }).lean()).toBeNull();

    /* The accepted limits still pass, and whitespace is still normalised. */
    const ok = await makeTemplate(w.maker, w, {
      layoutId: source.layout.layoutId, name: `  ${"N".repeat(160)}  `, description: "  spaced   out  ",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.template.name).toBe("N".repeat(160));
    expect(ok.body.template.description).toBe("spaced out");
  });

  test("on edit, both fields, with no revision, history or timestamp movement", async () => {
    const w = await world("OversizeEdit");
    const source = await arranged(w);
    const template = (await makeTemplate(w.maker, w, {
      layoutId: source.layout.layoutId, name: "Editable", description: "short",
    })).body.template;
    const before = await IeLineTemplate.findById(template.templateId).lean();

    for (const [body, field] of [
      [{ expectedRevision: template.revision, name: "N".repeat(161) }, "name"],
      [{ expectedRevision: template.revision, description: "D".repeat(1001) }, "description"],
    ]) {
      const res = await patchTemplate(w.maker, w, template.templateId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({ field, code: "TOO_LONG" });
    }

    const after = await IeLineTemplate.findById(template.templateId).lean();
    expect(after.name).toBe("Editable");
    expect(after.description).toBe("short");
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
  });
});

describe("two applications, one winner", () => {
  test("simultaneous applications against one revision: exactly one lands", async () => {
    const w = await world("ApplyRace");
    const source = await arranged(w);
    const first = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Race A" })).body.template;
    /* A second, DIFFERENT pattern, so a mixed result would be visible. */
    const flipped = await patchLayout(w.maker, w, source.layout.layoutId, {
      expectedRevision: source.layout.revision,
      stations: [{
        label: "One station", plannedMachineTypes: [{ machineType: "SNLS", quantity: 4 }],
        assignments: source.layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(flipped.status).toBe(200);
    const second = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Race B" })).body.template;

    const target = await freshTarget(w);
    const [one, two] = await Promise.all([
      apply(w.maker, w, target.layoutId, { templateId: first.templateId, expectedRevision: target.revision }),
      apply(w.maker, w, target.layoutId, { templateId: second.templateId, expectedRevision: target.revision }),
    ]);

    const winners = [one, two].filter((r) => r.status === 200 && r.body.updated === true);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(loser.body.error.details).toMatchObject({ expected: target.revision, actual: target.revision + 1 });

    const stored = await IeLineLayout.findById(target.layoutId).lean();
    /* One increment, one application entry, and one whole arrangement. */
    expect(stored.revision).toBe(target.revision + 1);
    const events = stored.history.filter((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED");
    expect(events).toHaveLength(1);
    /* No mixture: the stations are exactly one template's pattern, and the
       event names that same template. */
    const winnerTemplate = winners[0].body.applied.templateId;
    expect(String(events[0].templateId)).toBe(winnerTemplate);
    const expectedStations = winnerTemplate === first.templateId ? 2 : 1;
    expect(stored.stations).toHaveLength(expectedStations);
    expect(stored.stations.flatMap((s) => s.assignments.map((a) => a.rowId)).sort())
      .toEqual(target.source.rows.map((r) => r.rowId).sort());
  });

  test("a stale request conflicts even when its outcome would be a no-op", async () => {
    const w = await world("StaleApplyNoOp");
    const source = await arranged(w);
    const template = (await makeTemplate(w.maker, w, { layoutId: source.layout.layoutId, name: "Stale pattern" })).body.template;
    const target = await freshTarget(w);

    const applied = await apply(w.maker, w, target.layoutId, {
      templateId: template.templateId, expectedRevision: target.revision,
    });
    expect(applied.status).toBe(200);
    const now = applied.body.layout.revision;

    /* Applying the SAME template again at the current revision is an honest
       no-op — the arrangement is already this pattern. */
    const noop = await apply(w.maker, w, target.layoutId, {
      templateId: template.templateId, expectedRevision: now,
    });
    expect(noop.status).toBe(200);
    expect(noop.body.updated).toBe(false);
    expect(noop.body.events).toEqual([]);

    /* The same request at the OLD revision is a conflict, not a no-op: the
       caller is deciding from a state that no longer exists. */
    const stale = await apply(w.maker, w, target.layoutId, {
      templateId: template.templateId, expectedRevision: target.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: target.revision, actual: now });

    const stored = await IeLineLayout.findById(target.layoutId).lean();
    expect(stored.revision).toBe(now);
    expect(stored.history.filter((e) => e.type === "LINE_LAYOUT_TEMPLATE_APPLIED")).toHaveLength(1);
  });
});
