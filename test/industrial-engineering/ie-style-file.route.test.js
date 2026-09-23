// test/industrial-engineering/ie-style-file.route.test.js
//
// IE CHUNK 3A — THE STYLE ENGINEERING FILE AND ITS DRAFT BULLETIN, AT THE WIRE.
//
// The claims worth holding are the ones that decide whether an engineering
// department can be given a bulletin editor:
//
//   · a file is reached through an ORDER, because that is what proves the
//     style is this company's — a style named on somebody else's order, a
//     foreign file id and one that never existed are one answer;
//   · it is created from the EXACT approved R&D revision, refuses when there
//     is none and refuses when there are two, and keeps that snapshot for ever;
//   · nothing maps the legacy route onto the company library, so a new file
//     starts empty with a typed gap rather than a guessed route;
//   · creation is idempotent because the DATABASE says so — four simultaneous
//     requests produce one file;
//   · a row's identity survives reordering, and its code, name, machine type
//     and operation revision are written by the server, never by the browser;
//   · a bad row refuses the whole save — a half-applied bulletin is a route
//     nobody authored;
//   · null SAM is not zero;
//   · two edits quoting one revision produce exactly one winner;
//   · and the bulletin and its audit entry move together or not at all.
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

const ieStyleFile = require("../../services/industrialEngineering/ieStyleFile.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  /* The idempotency claim is a claim about an INDEX. */
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
  const email = `ie3a${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `E${n}`, email, biometricId: `IE3A${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
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
      { id: String(emp._id), email, name: `IE Engineer ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `Enquiry ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });
  return { co, journey, enquiry };
}

const product = (label) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-${label}-${++seq}`, reference: `REF-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  variants: [{ sku: `VAR-${label}-${seq}`, cost: 0, salesPrice: 0 }],
});

/** A frozen approved technical revision, in the shape R&D actually stores. */
const approvedRevision = (revision, operations = []) => ({
  revision,
  submittedAt: new Date("2026-08-01"),
  outcome: "approved",
  decidedAt: new Date("2026-08-05"),
  snapshot: {
    revision,
    materials: [],
    requirements: [],
    operations: operations.map((o) => ({
      operationId: String(new mongoose.Types.ObjectId()),
      operationCode: o.code, name: o.name, machineType: o.machine || "SNLS",
      minutes: o.minutes ?? 1, seconds: o.seconds ?? 0,
      samMinutes: (o.minutes ?? 1) + (o.seconds ?? 0) / 60,
      notes: "",
    })),
  },
});

/**
 * One company, one product, one work order, and a style on it whose technical
 * record is APPROVED at the given revision.
 */
async function world(name, {
  technicalStatus = "approved",
  revisions = [approvedRevision(3, [{ code: "SEW-1", name: "Side seam" }, { code: "HEM-1", name: "Hem" }])],
} = {}) {
  const ctx = await company(name);
  const item = await product(name);
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${++seq}`,
    stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference,
    quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    estimatedCost: 184000, actualCost: 190500,
  });
  const s = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${++seq}`, productName: `Tee ${name}`,
    styleCode: `ST-${name}`, variantLabel: "Navy",
    journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: {
      technical: { status: technicalStatus, revision: revisions.length ? revisions[revisions.length - 1].revision : 0 },
      technicalRevisions: revisions,
    },
    production: { workOrderIds: [wo._id] },
  });
  return { ...ctx, product: item, workOrder: wo, style: s };
}

/** An operation in the company library, through the accepted Chunk 2A door. */
async function libraryOperation(a, co, { code, name, machineType = "SNLS" }) {
  const res = await call("/operations/library", {
    method: "POST", token: a.token, company: co._id, body: { code, name, machineType },
  });
  expect(res.status).toBe(201);
  return res.body.operation;
}

const filePath = (w) => `/orders/${w.workOrder._id}/styles/${w.style._id}/engineering-file`;

async function openFile(a, w) {
  const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
  expect(res.status).toBe(201);
  return res.body.file;
}

/* ══ 1. ACCESS, ROLE AND COMPANY ══════════════════════════════════════════ */

describe("who may open and edit an engineering file", () => {
  test("a viewer reads the file and its history, and can change neither", async () => {
    const w = await world("ViewerFile");
    const editor = await editorIn(w.co);
    const file = await openFile(editor, w);

    const viewer = await viewerIn(w.co);
    expect((await call(filePath(w), { token: viewer.token, company: w.co._id })).status).toBe(200);
    expect((await call(`/engineering-files/${file.fileId}/history`, { token: viewer.token, company: w.co._id })).status).toBe(200);

    for (const [method, path, body] of [
      ["POST", filePath(w), {}],
      ["PATCH", `/engineering-files/${file.fileId}/bulletin`, { expectedRevision: 1, rows: [] }],
    ]) {
      const res = await call(path, { method, token: viewer.token, company: w.co._id, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
      expect(res.body.error.details.requires).toEqual({ department: "ie", minimumRole: "editor" });
    }
    expect((await IeStyleFile.findById(file.fileId).lean()).revision).toBe(1);
  });

  test("membership alone cannot open a file, and an IE role alone cannot either", async () => {
    const w = await world("BothChecks");
    await company("SecondCompanySoNoSingleCompanyFallback");

    const member = await actor({ companies: [w.co], grants: {} });
    const denied = await call(filePath(w), { method: "POST", token: member.token, company: w.co._id, body: {} });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("IE_WRITE_FORBIDDEN");

    const stranger = await actor({ companies: [], grants: { ie: "owner" } });
    const unproven = await call(filePath(w), { method: "POST", token: stranger.token, company: w.co._id, body: {} });
    expect(unproven.status).toBe(403);
    expect(unproven.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    expect(await IeStyleFile.countDocuments({})).toBe(0);
  });

  test("another company's file, order and style are all not-found", async () => {
    const mine = await world("MineFile");
    const theirs = await world("TheirsFile");
    const other = await editorIn(theirs.co);
    const theirFile = await openFile(other, theirs);

    const a = await editorIn(mine.co);
    const foreignFile = await call(`/engineering-files/${theirFile.fileId}/history`, { token: a.token, company: mine.co._id });
    const inventedFile = await call(`/engineering-files/${new mongoose.Types.ObjectId()}/history`, { token: a.token, company: mine.co._id });
    expect(foreignFile.status).toBe(404);
    expect(foreignFile.body).toEqual(inventedFile.body);

    const foreignPatch = await call(`/engineering-files/${theirFile.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: mine.co._id, body: { expectedRevision: 1, rows: [] },
    });
    expect(foreignPatch.status).toBe(404);
    expect(foreignPatch.body.error.code).toBe("IE_FILE_NOT_FOUND");
    /* Untouched. */
    expect((await IeStyleFile.findById(theirFile.fileId).lean()).revision).toBe(1);
  });

  test("a style that is not on the order is refused without saying whose it is", async () => {
    const mine = await world("OrderA");
    const other = await world("OrderB");
    const a = await editorIn(mine.co);

    const wrongStyle = await call(`/orders/${mine.workOrder._id}/styles/${other.style._id}/engineering-file`, {
      method: "POST", token: a.token, company: mine.co._id, body: {},
    });
    const inventedStyle = await call(`/orders/${mine.workOrder._id}/styles/${new mongoose.Types.ObjectId()}/engineering-file`, {
      method: "POST", token: a.token, company: mine.co._id, body: {},
    });
    expect(wrongStyle.status).toBe(404);
    expect(wrongStyle.body.error.code).toBe("IE_STYLE_NOT_ON_ORDER");
    expect(wrongStyle.body).toEqual(inventedStyle.body);
    expect(await IeStyleFile.countDocuments({})).toBe(0);
  });

  test("creation takes no authority from the body", async () => {
    const w = await world("BodyAuthority");
    const a = await editorIn(w.co);
    for (const body of [
      { companyId: String(w.co._id) },
      { sampleStyleId: String(w.style._id) },
      { customerName: "Northwind" },
      { source: { technicalRevision: 9 } },
    ]) {
      const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeStyleFile.countDocuments({})).toBe(0);
  });
});

/* ══ 2. THE APPROVED SOURCE ═══════════════════════════════════════════════ */

describe("a file is created from the approved technical version and nothing else", () => {
  test("a style with no approved technical version cannot have a file", async () => {
    const w = await world("NotApproved", { technicalStatus: "draft", revisions: [] });
    const a = await editorIn(w.co);
    const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_SOURCE_VERSION_REQUIRED");
    expect(res.body.error.details.technicalStatus).toBe("draft");
    expect(await IeStyleFile.countDocuments({})).toBe(0);
  });

  test("approved with no frozen revision to engineer from is refused too", async () => {
    const w = await world("ApprovedButEmpty", { technicalStatus: "approved", revisions: [] });
    const a = await editorIn(w.co);
    const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_SOURCE_VERSION_REQUIRED");
  });

  test("two approved copies of one revision are ambiguous, and nothing is chosen", async () => {
    const w = await world("Ambiguous", {
      revisions: [approvedRevision(2, [{ code: "A-1", name: "A" }]), approvedRevision(2, [{ code: "B-1", name: "B" }])],
    });
    const a = await editorIn(w.co);
    const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_SOURCE_VERSION_AMBIGUOUS");
    expect(res.body.error.details).toMatchObject({ technicalRevision: 2, approvedCopies: 2 });
    expect(await IeStyleFile.countDocuments({})).toBe(0);
  });

  test("the highest approved revision is the source, and its snapshot is kept", async () => {
    const w = await world("Source", {
      revisions: [
        approvedRevision(1, [{ code: "OLD-1", name: "Old" }]),
        approvedRevision(4, [{ code: "SEW-1", name: "Side seam" }, { code: "HEM-1", name: "Hem" }]),
      ],
    });
    const a = await editorIn(w.co);
    const res = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const file = res.body.file;
    expect(file.source.technicalRevision).toBe(4);
    expect(file.source.operationCount).toBe(2);
    expect(file.source.operations.map((o) => o.operationCode)).toEqual(["SEW-1", "HEM-1"]);
    expect(file.status).toBe("DRAFT");
    expect(file.revision).toBe(1);
    expect(file.canApprove).toBe(false);

    /* The stored snapshot is R&D's frozen copy, kept whole. */
    const stored = await IeStyleFile.findById(file.fileId).lean();
    expect(stored.source.snapshot.operations).toHaveLength(2);
    expect(stored.source.technicalRevision).toBe(4);
  });

  test("the bulletin starts EMPTY with a typed mapping gap — no route is guessed", async () => {
    const w = await world("NoGuessing");
    const a = await editorIn(w.co);
    const file = await openFile(a, w);

    expect(file.bulletin.rows).toEqual([]);
    expect(file.bulletin.rowCount).toBe(0);
    expect(file.readiness.ready).toBe(false);
    const codes = file.readiness.gaps.map((g) => g.code);
    expect(codes).toContain("IE_BULLETIN_EMPTY");
    expect(codes).toContain("IE_SOURCE_ROUTE_UNMAPPED");
    const unmapped = file.readiness.gaps.find((g) => g.code === "IE_SOURCE_ROUTE_UNMAPPED");
    expect(unmapped).toMatchObject({
      owner: "INDUSTRIAL_ENGINEERING", action: "MAP_SOURCE_ROUTE_TO_LIBRARY", sourceOperationCount: 2,
    });
    expect(typeof unmapped.message).toBe("string");
    /* And no company operation was invented to fill it. */
    expect(await IeOperation.countDocuments({})).toBe(0);
  });

  test("R&D approving a newer revision raises a gap and rewrites nothing", async () => {
    const w = await world("Superseded", { revisions: [approvedRevision(2, [{ code: "SEW-1", name: "Side seam" }])] });
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    expect(file.source.technicalRevision).toBe(2);

    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "techSheet.technical.revision": 3 },
      $push: { "techSheet.technicalRevisions": approvedRevision(3, [{ code: "SEW-1", name: "Side seam" }, { code: "NEW-1", name: "New" }]) },
    });

    const after = await call(filePath(w), { token: a.token, company: w.co._id });
    expect(after.status).toBe(200);
    /* The file still says 2 — nothing re-based it. */
    expect(after.body.file.source.technicalRevision).toBe(2);
    expect(after.body.file.source.operations.map((o) => o.operationCode)).toEqual(["SEW-1"]);
    const gap = after.body.file.readiness.gaps.find((g) => g.code === "IE_SOURCE_VERSION_SUPERSEDED");
    expect(gap).toMatchObject({
      owner: "RESEARCH_DEVELOPMENT", action: "REVIEW_NEW_TECHNICAL_VERSION",
      fileSourceRevision: 2, approvedRevision: 3,
    });
  });
});

/* ══ 3. IDEMPOTENT CREATION ═══════════════════════════════════════════════ */

describe("opening a file twice opens one file", () => {
  test("the second request returns the same file and says it did not create it", async () => {
    const w = await world("Idempotent");
    const a = await editorIn(w.co);
    const first = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
    const second = await call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.file.fileId).toBe(first.body.file.fileId);
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);
    /* One creation event, not two. */
    const stored = await IeStyleFile.findById(first.body.file.fileId).lean();
    expect(stored.history.filter((e) => e.type === "FILE_CREATED")).toHaveLength(1);
  });

  test("four simultaneous requests produce one file", async () => {
    const w = await world("RaceCreate");
    const a = await editorIn(w.co);
    const send = () => call(filePath(w), { method: "POST", token: a.token, company: w.co._id, body: {} });
    const results = await Promise.all([send(), send(), send(), send()]);

    const ids = new Set(results.map((r) => r.body?.file?.fileId));
    expect([...ids]).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(results.filter((r) => r.body.created === true).length).toBe(1);
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);

    const indexes = await IeStyleFile.collection.indexes();
    expect(indexes.find((i) => i.name === "ie_style_file_one_per_style_per_company"))
      .toMatchObject({ unique: true, key: { companyId: 1, sampleStyleId: 1 } });
  });
});

/* ══ 4. THE DRAFT BULLETIN ════════════════════════════════════════════════ */

describe("editing the draft bulletin", () => {
  async function ready(name) {
    const w = await world(name);
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam", machineType: "SNLS" });
    const hem = await libraryOperation(a, w.co, { code: "HEM-01", name: "Hem", machineType: "FOA" });
    return { w, a, file, sew, hem };
  }
  const patch = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin`, {
    method: "PATCH", token: a.token, company: w.co._id, body,
  });

  test("rows are stored with server-written identity, and the sequence is normalised", async () => {
    const { w, a, file, sew, hem } = await ready("AddRows");
    const res = await patch(a, w, file.fileId, {
      expectedRevision: 1,
      rows: [
        { ieOperationId: sew.operationId, proposedSamMinutes: 1.5 },
        { ieOperationId: hem.operationId, note: "double needle" },
      ],
    });

    expect(res.status).toBe(200);
    const rows = res.body.file.bulletin.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      ieOperationId: sew.operationId, ieOperationRevision: 1,
      operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
      proposedSamMinutes: 1.5,
    });
    expect(rows[1]).toMatchObject({ operationCode: "HEM-01", machineType: "FOA", proposedSamMinutes: null, note: "double needle" });
    expect(rows.every((r) => /^row_[0-9a-f]{18}$/.test(r.rowId))).toBe(true);
    expect(res.body.file.revision).toBe(2);
  });

  test("a row keeps its id through reordering, and the sequence follows the list", async () => {
    const { w, a, file, sew, hem } = await ready("Reorder");
    const first = await patch(a, w, file.fileId, {
      expectedRevision: 1,
      rows: [{ ieOperationId: sew.operationId }, { ieOperationId: hem.operationId }],
    });
    const [rowA, rowB] = first.body.file.bulletin.rows;

    const flipped = await patch(a, w, file.fileId, {
      expectedRevision: first.body.file.revision,
      rows: [{ rowId: rowB.rowId, ieOperationId: hem.operationId }, { rowId: rowA.rowId, ieOperationId: sew.operationId }],
    });

    expect(flipped.status).toBe(200);
    const rows = flipped.body.file.bulletin.rows;
    expect(rows.map((r) => r.rowId)).toEqual([rowB.rowId, rowA.rowId]);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(rows.map((r) => r.operationCode)).toEqual(["HEM-01", "SEW-01"]);
    /* Reordering is what happened, and that is what the history says. */
    const history = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    expect(history.body.events.map((e) => e.type)).toContain("BULLETIN_REORDERED");
    expect(history.body.events.filter((e) => e.type === "BULLETIN_ROW_ADDED")).toHaveLength(2);
  });

  test("an operation from another company is refused, and nothing is written", async () => {
    const { w, a, file, sew } = await ready("ForeignOp");
    const theirs = await world("TheirLibrary");
    const other = await editorIn(theirs.co);
    const theirOp = await libraryOperation(other, theirs.co, { code: "X-01", name: "Theirs" });

    const good = await patch(a, w, file.fileId, {
      expectedRevision: 1, rows: [{ ieOperationId: sew.operationId, proposedSamMinutes: 1 }],
    });
    expect(good.status).toBe(200);

    for (const bad of [theirOp.operationId, String(new mongoose.Types.ObjectId()), "not-an-id"]) {
      const res = await patch(a, w, file.fileId, {
        expectedRevision: 2,
        rows: [{ rowId: good.body.file.bulletin.rows[0].rowId, ieOperationId: sew.operationId }, { ieOperationId: bad }],
      });
      expect(res.status).toBe(400);
      expect(["IE_BULLETIN_OPERATION_NOT_FOUND", "VALIDATION"]).toContain(res.body.error.code);
      /* NO PARTIAL WRITE: the good row in the same body did not land either. */
      const stored = await IeStyleFile.findById(file.fileId).lean();
      expect(stored.revision).toBe(2);
      expect(stored.bulletin.rows).toHaveLength(1);
    }
  });

  test("duplicate and unknown row ids are refused", async () => {
    const { w, a, file, sew } = await ready("RowIds");
    const first = await patch(a, w, file.fileId, { expectedRevision: 1, rows: [{ ieOperationId: sew.operationId }] });
    const rowId = first.body.file.bulletin.rows[0].rowId;

    const duplicate = await patch(a, w, file.fileId, {
      expectedRevision: 2,
      rows: [{ rowId, ieOperationId: sew.operationId }, { rowId, ieOperationId: sew.operationId }],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe("IE_BULLETIN_ROW_DUPLICATE");

    const unknown = await patch(a, w, file.fileId, {
      expectedRevision: 2, rows: [{ rowId: "row_deadbeefdeadbeefde", ieOperationId: sew.operationId }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("VALIDATION");
    expect(unknown.body.error.details.fieldErrors[0].field).toBe("rows.0.rowId");

    expect((await IeStyleFile.findById(file.fileId).lean()).revision).toBe(2);
  });

  test("a row cannot carry an approved standard time or its own identity fields", async () => {
    const { w, a, file, sew } = await ready("RefusedRowFields");
    for (const extra of [
      { samMinutes: 2 }, { approvedSamMinutes: 2 }, { sequence: 5 },
      { operationCode: "FAKE" }, { ieOperationRevision: 99 }, { allowance: 10 }, { colour: "blue" },
    ]) {
      const res = await patch(a, w, file.fileId, {
        expectedRevision: 1, rows: [{ ieOperationId: sew.operationId, ...extra }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect((await IeStyleFile.findById(file.fileId).lean()).bulletin.rows).toEqual([]);
  });

  test("null SAM is not zero, and a bad SAM is refused", async () => {
    const { w, a, file, sew, hem } = await ready("SamRules");
    const saved = await patch(a, w, file.fileId, {
      expectedRevision: 1,
      rows: [
        { ieOperationId: sew.operationId, proposedSamMinutes: 0 },
        { ieOperationId: hem.operationId },
      ],
    });
    expect(saved.status).toBe(200);
    const [zero, none] = saved.body.file.bulletin.rows;
    expect(zero.proposedSamMinutes).toBe(0);
    expect(none.proposedSamMinutes).toBeNull();

    const gaps = saved.body.file.readiness.gaps.filter((g) => g.code === "IE_PROPOSED_SAM_MISSING");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ rowId: none.rowId, owner: "INDUSTRIAL_ENGINEERING", action: "PROPOSE_SAM" });
    expect(saved.body.file.bulletin.samComplete).toBe(false);

    /* A negative time, a number sent as text, and one past the cap are all
       refused. NaN and Infinity are deliberately NOT in this list: JSON cannot
       carry either, so they arrive as `null` — which this contract reads as
       "no proposal yet", the honest reading of a value that did not survive
       the wire. The service still refuses them for any caller that is not
       JSON (see `Number.isFinite` in readProposedSam). */
    for (const bad of [-1, "1.5", 10001]) {
      const res = await patch(a, w, file.fileId, {
        expectedRevision: 2, rows: [{ ieOperationId: sew.operationId, proposedSamMinutes: bad }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.fieldErrors[0].field).toBe("rows.0.proposedSamMinutes");
    }
    const overWire = await patch(a, w, file.fileId, {
      expectedRevision: 2, rows: [{ ieOperationId: sew.operationId, proposedSamMinutes: Number.NaN }],
    });
    expect(overWire.status).toBe(200);
    expect(overWire.body.file.bulletin.rows[0].proposedSamMinutes).toBeNull();
    expect(overWire.body.file.readiness.gaps.some((g) => g.code === "IE_PROPOSED_SAM_MISSING")).toBe(true);
  });

  test("the total is deterministic and samComplete follows every row", async () => {
    const { w, a, file, sew, hem } = await ready("Totals");
    const saved = await patch(a, w, file.fileId, {
      expectedRevision: 1,
      rows: [
        { ieOperationId: sew.operationId, proposedSamMinutes: 1.25 },
        { ieOperationId: hem.operationId, proposedSamMinutes: 0.75 },
      ],
    });
    expect(saved.body.file.bulletin.totalProposedSamMinutes).toBe(2);
    expect(saved.body.file.bulletin.samComplete).toBe(true);
    expect(saved.body.file.bulletin.rowsMissingProposedSam).toBe(0);

    /* Read twice: the same stored rows produce the same number. */
    const a2 = await call(filePath(w), { token: a.token, company: w.co._id });
    expect(a2.body.file.bulletin.totalProposedSamMinutes).toBe(2);

    const withGap = await patch(a, w, file.fileId, {
      expectedRevision: saved.body.file.revision,
      rows: saved.body.file.bulletin.rows.map((r, i) => ({
        rowId: r.rowId, ieOperationId: r.ieOperationId,
        ...(i === 1 ? {} : { proposedSamMinutes: r.proposedSamMinutes }),
      })),
    });
    expect(withGap.body.file.bulletin.samComplete).toBe(false);
    expect(withGap.body.file.bulletin.totalProposedSamMinutes).toBe(1.25);
  });

  test("an empty bulletin is allowed, and is not ready", async () => {
    const { w, a, file, sew } = await ready("EmptyAllowed");
    const filled = await patch(a, w, file.fileId, { expectedRevision: 1, rows: [{ ieOperationId: sew.operationId }] });
    const emptied = await patch(a, w, file.fileId, { expectedRevision: filled.body.file.revision, rows: [] });

    expect(emptied.status).toBe(200);
    expect(emptied.body.file.bulletin.rows).toEqual([]);
    expect(emptied.body.file.bulletin.totalProposedSamMinutes).toBeNull();
    expect(emptied.body.file.readiness.ready).toBe(false);
    expect(emptied.body.file.readiness.gaps.map((g) => g.code)).toContain("IE_BULLETIN_EMPTY");
    /* Removing a row is an event, not a silent truncation. */
    const history = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    expect(history.body.events[0].type).toBe("BULLETIN_ROW_REMOVED");
  });

  test("a retired operation stays readable and raises a gap", async () => {
    const { w, a, file, sew } = await ready("RetiredOp");
    const saved = await patch(a, w, file.fileId, {
      expectedRevision: 1, rows: [{ ieOperationId: sew.operationId, proposedSamMinutes: 1 }],
    });
    await call(`/operations/library/${sew.operationId}/retire`, {
      method: "POST", token: a.token, company: w.co._id, body: { expectedRevision: 1 },
    });

    const after = await call(filePath(w), { token: a.token, company: w.co._id });
    expect(after.status).toBe(200);
    /* Still there, still legible. */
    expect(after.body.file.bulletin.rows[0]).toMatchObject({ operationCode: "SEW-01", proposedSamMinutes: 1 });
    const gap = after.body.file.readiness.gaps.find((g) => g.code === "IE_BULLETIN_OPERATION_RETIRED");
    expect(gap).toMatchObject({
      owner: "INDUSTRIAL_ENGINEERING", action: "REPLACE_RETIRED_OPERATION",
      rowId: saved.body.file.bulletin.rows[0].rowId,
    });
    /* And the bulletin can still be edited — a retired row does not freeze it. */
    const stillEditable = await patch(a, w, file.fileId, {
      expectedRevision: after.body.file.revision,
      rows: [{ rowId: after.body.file.bulletin.rows[0].rowId, ieOperationId: sew.operationId, proposedSamMinutes: 2 }],
    });
    expect(stillEditable.status).toBe(200);
  });
});

/* ══ 5. CONCURRENCY AND AUDIT ATOMICITY ═══════════════════════════════════ */

describe("one revision, one winner, one history", () => {
  test("two edits quoting the same revision: exactly one lands", async () => {
    const w = await world("PatchRace");
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam" });
    const hem = await libraryOperation(a, w.co, { code: "HEM-01", name: "Hem" });

    const send = (opId, sam) => call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { expectedRevision: 1, rows: [{ ieOperationId: opId, proposedSamMinutes: sam }] },
    });
    const [one, two] = await Promise.all([send(sew.operationId, 1), send(hem.operationId, 2)]);

    const winners = [one, two].filter((r) => r.status === 200);
    const losers = [one, two].filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers[0].status).toBe(409);
    expect(losers[0].body.error.code).toBe("IE_FILE_REVISION_CONFLICT");
    expect(losers[0].body.error.details).toMatchObject({ expected: 1, actual: 2 });

    const stored = await IeStyleFile.findById(file.fileId).lean();
    expect(stored.revision).toBe(2);
    expect(stored.bulletin.rows).toHaveLength(1);
    expect(stored.bulletin.rows[0].operationCode).toBe(winners[0].body.file.bulletin.rows[0].operationCode);
    /* The loser wrote no row AND no event. */
    expect(stored.history.filter((e) => e.type === "BULLETIN_ROW_ADDED")).toHaveLength(1);
  });

  test("a refused save appends no audit event, and an accepted one appends with the row", async () => {
    const w = await world("AuditAtomic");
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam" });

    const before = await IeStyleFile.findById(file.fileId).lean();
    expect(before.history).toHaveLength(1);

    /* Refused for a bad row… */
    const refused = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { expectedRevision: 1, rows: [{ ieOperationId: String(new mongoose.Types.ObjectId()) }] },
    });
    expect(refused.status).toBe(400);
    const afterRefusal = await IeStyleFile.findById(file.fileId).lean();
    expect(afterRefusal.history).toHaveLength(1);
    expect(afterRefusal.revision).toBe(1);
    expect(afterRefusal.bulletin.rows).toEqual([]);

    /* …and accepted, the row and its event are both there, at the same revision. */
    const ok = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { expectedRevision: 1, rows: [{ ieOperationId: sew.operationId, proposedSamMinutes: 1 }] },
    });
    expect(ok.status).toBe(200);
    const afterOk = await IeStyleFile.findById(file.fileId).lean();
    expect(afterOk.revision).toBe(2);
    expect(afterOk.bulletin.rows).toHaveLength(1);
    const added = afterOk.history.filter((e) => e.type === "BULLETIN_ROW_ADDED");
    expect(added).toHaveLength(1);
    expect(added[0].fileRevision).toBe(2);
    expect(added[0].rowId).toBe(afterOk.bulletin.rows[0].rowId);
  });

  test("the history reads newest first and names the actor and the revision", async () => {
    const w = await world("History");
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam" });

    const added = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { expectedRevision: 1, rows: [{ ieOperationId: sew.operationId }] },
    });
    await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: {
        expectedRevision: 2,
        rows: [{ rowId: added.body.file.bulletin.rows[0].rowId, ieOperationId: sew.operationId, proposedSamMinutes: 3 }],
      },
    });

    const res = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.type)).toEqual(["BULLETIN_ROW_EDITED", "BULLETIN_ROW_ADDED", "FILE_CREATED"]);
    expect(res.body.events[0]).toMatchObject({ fileRevision: 3, actorName: expect.stringMatching(/^IE Engineer /) });
    expect(res.body.events[0].summary).toMatch(/proposed SAM/);
    expect(res.body.fileRevision).toBe(3);
    /* Summaries are bounded and never carry the file itself. */
    for (const e of res.body.events) expect(e.summary.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(res.body)).not.toMatch(/snapshot|customerName|estimatedCost/);
  });
});

/* ══ 6. WHAT THIS CHUNK DOES NOT HAVE ═════════════════════════════════════ */

describe("no approval, no release, no delete", () => {
  test("there is no verb that approves, submits or releases a bulletin", async () => {
    const w = await world("NoApproval");
    const a = await actor({ companies: [w.co], grants: { ie: "owner" } });
    const file = await openFile(a, w);

    for (const path of [
      `/engineering-files/${file.fileId}/approve`,
      `/engineering-files/${file.fileId}/submit`,
      `/engineering-files/${file.fileId}/release`,
      `/engineering-files/${file.fileId}/bulletin/approve`,
    ]) {
      expect((await call(path, { method: "POST", token: a.token, company: w.co._id, body: {} })).status).toBe(404);
    }
    for (const path of [`/engineering-files/${file.fileId}`, `/engineering-files/${file.fileId}/bulletin`]) {
      expect((await call(path, { method: "DELETE", token: a.token, company: w.co._id })).status).toBe(404);
    }

    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    /* ── SCOPED TO THE ENGINEERING FILE, WHICH IS WHAT THIS TEST IS ABOUT ──
       Chunk 4B added an approval to the METHOD STUDY and a publish to the
       allowance POLICY, both deliberately and under maker-checker. Neither is
       an approval of the engineering file or its bulletin, and that is the
       claim held here: no verb on `/engineering-files/**` approves, submits,
       releases or publishes anything, and nothing anywhere applies a time to a
       bulletin row. */
    const fileVerbs = paths.filter((p) => p.startsWith("/engineering-files"));
    expect(fileVerbs.filter((p) => /approve|submit|release|publish/i.test(p))).toEqual([]);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(paths.filter((p) => /release|apply/i.test(p))
      .filter((p) => p !== "/style-files/:fileId/releases"
        && p !== "/releases/:releaseId/impact")).toEqual([]);
    const verbs = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    expect(verbs).not.toContain("delete");

    /* And the file says so, so a screen does not infer a control from DRAFT. */
    expect(file.canApprove).toBe(false);
    expect(file.approvalChunk).toBe("CHUNK_4");
    /* Nothing IE stores carries an approved time. The R&D snapshot inside
       `source` does carry R&D's own `samMinutes`, and must — it is their
       frozen record, kept whole. What matters is that no IE-authored field
       anywhere on the file is an approved standard. */
    const stored = await IeStyleFile.findById(file.fileId).lean();
    const { source, ...ieOwned } = stored;
    expect(JSON.stringify(ieOwned)).not.toMatch(/approvedSam|samMinutes|allowance|approvedAt/i);
    expect(Object.keys(stored)).not.toContain("approval");
    /* And a bulletin row holds a PROPOSAL, named as one. */
    const withRow = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: {
        expectedRevision: 1,
        rows: [{ ieOperationId: (await libraryOperation(a, w.co, { code: "Z-01", name: "Z" })).operationId, proposedSamMinutes: 1 }],
      },
    });
    expect(Object.keys(withRow.body.file.bulletin.rows[0])).toContain("proposedSamMinutes");
    expect(Object.keys(withRow.body.file.bulletin.rows[0])).not.toContain("samMinutes");
  });
});

/* ══ 7. THE SERVICE'S OWN RULES ═══════════════════════════════════════════ */

describe("the calculations, without a server", () => {
  test("SAM totals are deterministic, and null is not zero", () => {
    const rows = [{ proposedSamMinutes: 1.25 }, { proposedSamMinutes: 0 }, { proposedSamMinutes: 0.75 }];
    expect(ieStyleFile.samTotals(rows)).toEqual({
      totalProposedSamMinutes: 2, rowsMissingProposedSam: 0, samComplete: true,
    });
    /* Same rows, same answer — no accumulation of float drift between reads. */
    expect(ieStyleFile.samTotals(rows)).toEqual(ieStyleFile.samTotals([...rows]));

    expect(ieStyleFile.samTotals([{ proposedSamMinutes: 1 }, { proposedSamMinutes: null }])).toEqual({
      totalProposedSamMinutes: 1, rowsMissingProposedSam: 1, samComplete: false,
    });
    expect(ieStyleFile.samTotals([])).toEqual({
      totalProposedSamMinutes: null, rowsMissingProposedSam: 0, samComplete: false,
    });
    /* A row proposed at zero is a decision, not a gap. */
    expect(ieStyleFile.samTotals([{ proposedSamMinutes: 0 }])).toMatchObject({ samComplete: true });
  });

  test("the approved-source rule is the one Central Costing reads by", () => {
    const style = (technical, revisions) => ({ techSheet: { technical, technicalRevisions: revisions } });
    expect(() => ieStyleFile.approvedSourceOf(style({ status: "draft" }, [])))
      .toThrow(/no approved technical version/i);
    expect(() => ieStyleFile.approvedSourceOf(style({ status: "approved" }, [{ revision: 1, outcome: "submitted" }])))
      .toThrow(/no frozen approved revision/i);
    /* The highest revision, not the last element. */
    const picked = ieStyleFile.approvedSourceOf(style({ status: "approved" }, [
      { revision: 5, outcome: "approved", snapshot: { operations: [] } },
      { revision: 2, outcome: "approved", snapshot: { operations: [] } },
    ]));
    expect(picked.revision).toBe(5);
  });
});

/* ══ 8. THE SNAPSHOT A ROW WAS BUILT FROM STAYS PUT ═══════════════════════
 *
 * The library moves — an operation is renamed, its machine type corrected, its
 * revision bumped. A bulletin that already uses it must not quietly follow,
 * because it would then claim to have been engineered against a revision
 * nobody chose, on the save where somebody fixed a typo in a note. */

describe("an unrelated save does not re-base a row onto the latest operation", () => {
  const patch = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin`, {
    method: "PATCH", token: a.token, company: w.co._id, body,
  });

  async function bulletinWithOneRow(name) {
    const w = await world(name);
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const op = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam", machineType: "SNLS" });
    const saved = await patch(a, w, file.fileId, {
      expectedRevision: 1, rows: [{ ieOperationId: op.operationId, proposedSamMinutes: 1.5 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.file.bulletin.rows[0]).toMatchObject({
      ieOperationRevision: 1, operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
    });
    return { w, a, file, op, row: saved.body.file.bulletin.rows[0], revision: saved.body.file.revision };
  }

  /** Move the library on: new revision, new name, new machine type. */
  async function moveTheLibraryOn(a, w, op) {
    const res = await call(`/operations/library/${op.operationId}`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { name: "Side seam (twin needle)", machineType: "DNLS", expectedRevision: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.operation).toMatchObject({ revision: 2, name: "Side seam (twin needle)", machineType: "DNLS" });
    return res.body.operation;
  }

  test("editing only the note keeps the row's original operation revision and snapshot", async () => {
    const { w, a, file, op, row, revision } = await bulletinWithOneRow("PreserveNote");
    await moveTheLibraryOn(a, w, op);

    const noted = await patch(a, w, file.fileId, {
      expectedRevision: revision,
      rows: [{ rowId: row.rowId, ieOperationId: op.operationId, proposedSamMinutes: 1.5, note: "keep tension low" }],
    });

    expect(noted.status).toBe(200);
    expect(noted.body.updated).toBe(true);
    const after = noted.body.file.bulletin.rows[0];
    expect(after.note).toBe("keep tension low");
    /* The whole point: none of these followed the library. */
    expect(after).toMatchObject({
      rowId: row.rowId, ieOperationRevision: 1,
      operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
    });

    /* And nothing in the history claims the operation changed. */
    const history = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    const edits = history.body.events.filter((e) => e.type === "BULLETIN_ROW_EDITED");
    expect(edits).toHaveLength(1);
    expect(edits[0].summary).toMatch(/note/);
    expect(edits[0].summary).not.toMatch(/operation/i);
  });

  test("a SAM change and a reorder do not refresh the snapshot either", async () => {
    const { w, a, file, op, row, revision } = await bulletinWithOneRow("PreserveSamAndOrder");
    const second = await libraryOperation(a, w.co, { code: "HEM-01", name: "Hem", machineType: "FOA" });
    const two = await patch(a, w, file.fileId, {
      expectedRevision: revision,
      rows: [
        { rowId: row.rowId, ieOperationId: op.operationId, proposedSamMinutes: 1.5 },
        { ieOperationId: second.operationId, proposedSamMinutes: 0.5 },
      ],
    });
    const hemRow = two.body.file.bulletin.rows[1];
    await moveTheLibraryOn(a, w, op);

    const retimed = await patch(a, w, file.fileId, {
      expectedRevision: two.body.file.revision,
      rows: [
        { rowId: row.rowId, ieOperationId: op.operationId, proposedSamMinutes: 2.25 },
        { rowId: hemRow.rowId, ieOperationId: second.operationId, proposedSamMinutes: 0.5 },
      ],
    });
    expect(retimed.body.file.bulletin.rows[0]).toMatchObject({
      ieOperationRevision: 1, operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
      proposedSamMinutes: 2.25,
    });

    const flipped = await patch(a, w, file.fileId, {
      expectedRevision: retimed.body.file.revision,
      rows: [
        { rowId: hemRow.rowId, ieOperationId: second.operationId, proposedSamMinutes: 0.5 },
        { rowId: row.rowId, ieOperationId: op.operationId, proposedSamMinutes: 2.25 },
      ],
    });
    expect(flipped.body.file.bulletin.rows[1]).toMatchObject({
      ieOperationRevision: 1, operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
    });

    const history = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    expect(history.body.events.filter((e) => /operation/i.test(e.summary) && e.type === "BULLETIN_ROW_EDITED")).toEqual([]);
  });

  test("replacing a row's operation DOES capture the replacement's current snapshot", async () => {
    const { w, a, file, op, row, revision } = await bulletinWithOneRow("ReplaceOperation");
    const replacement = await libraryOperation(a, w.co, { code: "OL-01", name: "Overlock", machineType: "OL3" });
    /* Move the replacement on too, so "current" is provably not "revision 1". */
    const moved = await call(`/operations/library/${replacement.operationId}`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { name: "Overlock 4-thread", machineType: "OL4", expectedRevision: 1 },
    });
    expect(moved.body.operation.revision).toBe(2);
    await moveTheLibraryOn(a, w, op);

    const replaced = await patch(a, w, file.fileId, {
      expectedRevision: revision,
      rows: [{ rowId: row.rowId, ieOperationId: replacement.operationId, proposedSamMinutes: 1.5 }],
    });

    expect(replaced.status).toBe(200);
    expect(replaced.body.file.bulletin.rows[0]).toMatchObject({
      rowId: row.rowId,
      ieOperationId: replacement.operationId,
      ieOperationRevision: 2,
      operationCode: "OL-01", operationName: "Overlock 4-thread", machineType: "OL4",
    });
    const history = await call(`/engineering-files/${file.fileId}/history`, { token: a.token, company: w.co._id });
    expect(history.body.events[0]).toMatchObject({ type: "BULLETIN_ROW_EDITED", rowId: row.rowId });
    expect(history.body.events[0].summary).toMatch(/operation/i);
  });

  test("a retired operation still reads and still raises its gap, snapshot intact", async () => {
    const { w, a, file, op, row } = await bulletinWithOneRow("PreserveRetired");
    await moveTheLibraryOn(a, w, op);
    await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: w.co._id, body: { expectedRevision: 2 },
    });

    const after = await call(filePath(w), { token: a.token, company: w.co._id });
    expect(after.body.file.bulletin.rows[0]).toMatchObject({
      rowId: row.rowId, ieOperationRevision: 1, operationCode: "SEW-01", operationName: "Side seam",
    });
    expect(after.body.file.readiness.gaps.some((g) => g.code === "IE_BULLETIN_OPERATION_RETIRED")).toBe(true);
  });
});

/* ══ 9. A SAVE THAT CHANGES NOTHING ═══════════════════════════════════════ */

describe("no-op bulletin saves", () => {
  const patch = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin`, {
    method: "PATCH", token: a.token, company: w.co._id, body,
  });

  async function saved(name) {
    const w = await world(name);
    const a = await editorIn(w.co);
    const file = await openFile(a, w);
    const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam" });
    const hem = await libraryOperation(a, w.co, { code: "HEM-01", name: "Hem", machineType: "FOA" });
    const res = await patch(a, w, file.fileId, {
      expectedRevision: 1,
      rows: [
        { ieOperationId: sew.operationId, proposedSamMinutes: 1.5, note: "tension low" },
        { ieOperationId: hem.operationId, proposedSamMinutes: 0.75 },
      ],
    });
    expect(res.status).toBe(200);
    return { w, a, file, sew, hem, state: res.body.file };
  }

  /** The rows exactly as they are stored, in the shape a PATCH takes. */
  const resend = (state) => state.bulletin.rows.map((r) => ({
    rowId: r.rowId, ieOperationId: r.ieOperationId,
    proposedSamMinutes: r.proposedSamMinutes, note: r.note,
  }));

  test("a PATCH without rows is a typed validation error", async () => {
    const { w, a, file, state } = await saved("RowsRequired");
    const res = await patch(a, w, file.fileId, { expectedRevision: state.revision });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.details.field).toBe("rows");
    expect(res.body.error.details.fieldErrors[0].code).toBe("REQUIRED");
    /* Not treated as "keep what is there": nothing moved. */
    const stored = await IeStyleFile.findById(file.fileId).lean();
    expect(stored.revision).toBe(state.revision);
    expect(stored.bulletin.rows).toHaveLength(2);
  });

  test("re-sending the same bulletin changes nothing and says so", async () => {
    const { w, a, file, state } = await saved("NoOp");
    const before = await IeStyleFile.findById(file.fileId).lean();

    const res = await patch(a, w, file.fileId, { expectedRevision: state.revision, rows: resend(state) });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    /* The current file comes back, so a client still has something to render. */
    expect(res.body.file.fileId).toBe(file.fileId);
    expect(res.body.file.revision).toBe(state.revision);
    expect(res.body.file.bulletin.rows.map((r) => r.rowId)).toEqual(state.bulletin.rows.map((r) => r.rowId));

    const after = await IeStyleFile.findById(file.fileId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("rows that only LOOK different are still a no-op", async () => {
    const { w, a, file, state } = await saved("NormalisedNoOp");
    const before = await IeStyleFile.findById(file.fileId).lean();

    /* Padded notes and an omitted null SAM normalise to what is stored. */
    const res = await patch(a, w, file.fileId, {
      expectedRevision: state.revision,
      rows: [
        { rowId: state.bulletin.rows[0].rowId, ieOperationId: state.bulletin.rows[0].ieOperationId, proposedSamMinutes: 1.5, note: "  tension low  " },
        { rowId: state.bulletin.rows[1].rowId, ieOperationId: state.bulletin.rows[1].ieOperationId, proposedSamMinutes: 0.75 },
      ],
    });

    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    const after = await IeStyleFile.findById(file.fileId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
  });

  test("a stale no-op is still a revision conflict", async () => {
    const { w, a, file, state } = await saved("StaleNoOp");
    const res = await patch(a, w, file.fileId, { expectedRevision: state.revision - 1, rows: resend(state) });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_FILE_REVISION_CONFLICT");
    expect(res.body.error.details).toMatchObject({ expected: state.revision - 1, actual: state.revision });
  });

  test("note, SAM, operation and order changes are all still real updates", async () => {
    const { w, a, file, sew, hem, state } = await saved("RealChanges");
    const rows = resend(state);
    let revision = state.revision;

    const cases = [
      ["note", [{ ...rows[0], note: "different" }, rows[1]]],
      ["SAM", [{ ...rows[0], note: "different", proposedSamMinutes: 2 }, rows[1]]],
      ["order", [rows[1], { ...rows[0], note: "different", proposedSamMinutes: 2 }]],
      ["operation", [rows[1], { ...rows[0], note: "different", proposedSamMinutes: 2, ieOperationId: hem.operationId }]],
      ["removal", [rows[1]]],
    ];
    for (const [label, next] of cases) {
      const res = await patch(a, w, file.fileId, { expectedRevision: revision, rows: next });
      expect(res.status).toBe(200);
      expect(`${label}:${res.body.updated}`).toBe(`${label}:true`);
      expect(res.body.events.length).toBeGreaterThan(0);
      expect(res.body.file.revision).toBe(revision + 1);
      revision = res.body.file.revision;
    }
    expect(sew.operationId).toBeTruthy();
  });
});
