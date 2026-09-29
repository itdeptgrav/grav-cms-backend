// test/industrial-engineering/ie-source-rebase.route.test.js
//
// THE WAY OUT OF A SUPERSEDED TECHNICAL SOURCE.
//
// ── THE DEAD END THIS CLOSES ────────────────────────────────────────────────
// R&D approves revision 1. IE opens its file against that exact revision,
// builds a bulletin, submits it and has it approved. Central Costing binds the
// frozen source and quotes from it. Then the garment changes.
//
// At that point the whole chain stopped:
//
//   · `SAMPLE_TECHSHEET_TRANSITIONS.approved` was `[]`, so no mounted route
//     could reopen an approved technical record — revision 2 was not creatable
//     at all, by anybody;
//   · the engineering file froze the revision it was opened from and never
//     re-read it (rightly), but nothing was offered instead, so both submission
//     gates refused every future version as `IE_SOURCE_VERSION_SUPERSEDED`;
//   · and Central Costing's `IE_TECHNICAL_APPROVAL_STALE` named a state with no
//     action in the system that could ever clear it.
//
// ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
// Two explicit decisions, neither automatic. Sales reopens the approved
// technical record for a reason, and R&D revises, submits and is approved
// through the paths that already existed. IE then MOVES ITS FILE onto the newer
// revision — a successor cycle, recorded beside the original source rather than
// over it — is told what moved, reviews what the move reaches, and submits a
// new version for somebody else to approve.
//
// Nothing frozen is rewritten anywhere along that path, which is most of what
// this file asserts.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__SALES_ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__SALES_ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

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
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
/* The legacy operation register. R&D's technical route names rows from it, and
   approving a technical record syncs that route — so the rows have to exist. */
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");

const bind = require("../../services/centralCosting/approvedTechnicalSource.service");
const styleFiles = require("../../services/industrialEngineering/ieStyleFile.service");

let server, base, sales, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  sales = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
  await IeStyleFile.syncIndexes();
  await IeBulletinVersion.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const request = (url, { method = "GET", body, token, company } = {}) =>
  fetch(url, {
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

const call = (path, opts) => request(`${base}${path}`, opts);
const rnd = (path, opts) => request(`${sales}${path}`, opts);

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {}, role = "employee" } = {}) {
  const n = ++seq;
  const email = `rb${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "R", lastName: `B${n}`, email, biometricId: `RB${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });
  }
  for (const [departmentSlug, grant] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role: grant, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    id: String(emp._id),
    user: { id: String(emp._id), email, name: `Person ${n}`, role, employeeId: emp.biometricId },
    token: jwt.sign(
      { id: String(emp._id), email, name: `Person ${n}`, role, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "20m" },
    ),
  };
}

const RAW_ID = () => String(new mongoose.Types.ObjectId());

/** R&D's frozen approved revision, in the shape R&D's own route writes it. */
const approvedRevision = ({
  revision = 1,
  submittedAt = "2026-08-01",
  decidedAt = "2026-08-05",
  materials = [],
  operations = [],
} = {}) => ({
  revision,
  submittedAt: new Date(submittedAt),
  outcome: "approved",
  decidedAt: new Date(decidedAt),
  snapshot: {
    revision,
    materials: materials.map((m) => ({
      rawItemId: m.rawItemId,
      rawItemName: m.rawItemName,
      consumptionPerPiece: m.consumptionPerPiece,
      allowancePercent: m.allowancePercent ?? null,
      unit: "m",
      specification: m.specification || "",
    })),
    requirements: [],
    operations,
  },
});

/**
 * A company, its Sales parents, a style whose technical record is APPROVED at
 * revision 1, and the four people involved.
 *
 * Revision 1 is seeded frozen — it is the STARTING state this file is about,
 * not the thing under test. Revision 2 is created through the mounted route,
 * because "R&D can publish a newer revision at all" is precisely the claim.
 */
async function world(name, { consumption = 1.4, allowance = 5 } = {}) {
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
    name: `Tee ${name} ${n}`, sku: `SKU-${name}-${n}`, reference: `REF-${name}-${n}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
  });

  const rawItemId = RAW_ID();
  const material = {
    rawItemId, rawItemName: "Shell fabric", consumptionPerPiece: consumption,
    allowancePercent: allowance, unit: "m", specification: "160gsm jersey",
  };
  /* `operationId` is required on the stored row — it is the legacy operation
     register's id, and R&D's record names one per operation. Registered for
     real, because approving the record syncs the production route against it. */
  const seam = await Operation.create({
    name: "Side seam", operationCode: `OP-SEAM-${n}`, totalSam: 1.25, durationSeconds: 75, machineType: "SNLS",
  });
  const hem = await Operation.create({
    name: "Bottom hem", operationCode: `OP-HEM-${n}`, totalSam: 0.75, durationSeconds: 45, machineType: "FL",
  });
  const seamId = String(seam._id);
  const hemId = String(hem._id);
  const operations = [
    { operationId: seamId, operationCode: "OP-SEAM", name: "Side seam", machineType: "SNLS", minutes: 1, seconds: 15, samMinutes: 1.25 },
    { operationId: hemId, operationCode: "OP-HEM", name: "Bottom hem", machineType: "FL", minutes: 0, seconds: 45, samMinutes: 0.75 },
  ];

  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`, styleCode: `ST-${name}-${n}`,
    variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    /* The legacy shortlist form: identity only, which is what R&D's record is
       completed against. */
    materials: { status: "selected", rawItems: [{ rawItemId, rawItemName: "Shell fabric", unit: "m" }] },
    /* Merchandising's own approved decision about what the garment is made of.
       Central Costing compares the confirmed technical record against it, and
       without one it has nothing to bind — the selection is the other half of
       the chain and is not what this file is testing. */
    bomApproval: {
      status: "approved", round: 1,
      decidedAt: new Date("2026-08-04"),
      decidedByName: "Merch Lead", decidedByEmail: "merch@grav.test",
    },
    techSheet: {
      status: "approved",
      file: { name: "tech-rev-1.pdf", url: "https://example.test/tech-rev-1.pdf", uploadedAt: new Date("2026-08-01") },
      technical: {
        status: "approved",
        revision: 1,
        materials: [material],
        operations,
        requirements: [],
        approvedAt: new Date("2026-08-05"),
      },
      technicalRevisions: [approvedRevision({ materials: [material], operations })],
    },
  });

  const maker = await actor({ companies: [co], grants: { ie: "editor" } });
  const approver = await actor({ companies: [co], grants: { ie: "approver" } });
  const salesPerson = await actor({ companies: [co], role: "sales" });
  return {
    co, journey, enquiry, style, item, maker, approver, salesPerson,
    rawItemId, material, operations, seamId, hemId,
  };
}

const ctxOf = (w) => ({ companyId: w.co._id, actorId: new mongoose.Types.ObjectId() });

/* ── R&D, THROUGH ITS OWN MOUNTED ROUTE ──────────────────────────────────── */

const asSales = (w) => { global.__SALES_ACTOR__ = w.salesPerson.user; };

const techSheet = (w, body) =>
  rnd(`/${w.style._id}/tech-sheet`, { method: "POST", token: w.salesPerson.token, body });

/**
 * Publish a NEWER approved technical revision, entirely through mounted routes.
 *
 * Reopen (Sales, with a reason) → save the changed facts (R&D) → submit (R&D)
 * → approve (Sales). No collection is written directly: the point of the
 * journey is that every step of it exists.
 */
async function publishNextRevision(w, { consumption, allowance, operations, reason = "Buyer changed the fabric." } = {}) {
  asSales(w);
  const reopened = await techSheet(w, { action: "revise", note: reason });
  if (reopened.status !== 200) return reopened;

  if (operations) {
    /* The route does not write operations — they are Production's — so the
       change arrives the way it does in life: on the record, by its own owner. */
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "techSheet.technical.operations": operations } });
  }

  const saved = await rnd(`/${w.style._id}/technical`, {
    method: "PUT", token: w.salesPerson.token,
    body: {
      materials: [{
        rawItemId: w.rawItemId,
        rawItemName: "Shell fabric",
        consumptionPerPiece: consumption ?? w.material.consumptionPerPiece,
        allowancePercent: allowance ?? w.material.allowancePercent,
        unit: "m",
        specification: w.material.specification,
      }],
      requirements: [],
    },
  });
  if (saved.status !== 200) return saved;

  const submitted = await techSheet(w, {
    action: "submit",
    file: { name: "tech-rev-2.pdf", url: "https://example.test/tech-rev-2.pdf" },
  });
  if (submitted.status !== 200) return submitted;

  return techSheet(w, { action: "approve", note: "Reviewed and accepted." });
}

/* ── IE, THROUGH ITS OWN MOUNTED ROUTES ──────────────────────────────────── */

/** Everything a bulletin needs before it may be submitted, for one row. */
async function engineeringFile(w, { rows = 1 } = {}) {
  const t = { token: w.maker.token, company: w.co._id };

  const drafted = await call("/allowance-policies", {
    method: "POST", ...t,
    body: { name: `No allowance ${++seq}`, effectiveFrom: "2026-01-01", categories: [] },
  });
  await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
    method: "POST", token: w.approver.token, company: w.co._id, body: { expectedRevision: 1 },
  });

  const file = (await call(`/styles/${w.style._id}/engineering-file`, { method: "POST", ...t })).body.file;

  const built = [];
  for (let i = 0; i < rows; i += 1) {
    const op = (await call("/operations/library", {
      method: "POST", ...t,
      body: { code: i === 0 ? "OP-SEAM" : "OP-HEM", name: i === 0 ? "Side seam" : "Bottom hem", machineType: i === 0 ? "SNLS" : "FL" },
    })).body.operation;
    built.push(op);
  }

  const read = await call(`/styles/${w.style._id}/engineering-file`, t);
  const patched = await call(`/engineering-files/${file.fileId}/bulletin`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: read.body.file.revision,
      rows: built.map((op, i) => ({ ieOperationId: op.operationId, proposedSamMinutes: i === 0 ? 1.25 : 0.75 })),
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
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Two-hand method", ratingPercent: 100, observations: [{ durationSeconds: 75 }],
      },
    });
    const submittedStudy = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", ...t,
      body: {
        expectedRevision: filled.body.study.revision,
        manualStandardTimeMinutes: row.proposedSamMinutes,
        overrideReason: "Fixed standard agreed for this exercise.",
      },
    });
    await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: submittedStudy.body.study.revision },
    });
  }

  const current = await call(`/styles/${w.style._id}/engineering-file`, t);
  return { fileId: file.fileId, file: current.body.file, rows: patched.body.file.bulletin.rows };
}

const fileNow = (w) =>
  call(`/styles/${w.style._id}/engineering-file`, { token: w.maker.token, company: w.co._id })
    .then((r) => r.body.file);

async function submitAndApprove(w, fileId) {
  const file = await fileNow(w);
  const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
    method: "POST", token: w.maker.token, company: w.co._id,
    body: { expectedRevision: file.revision },
  });
  if (submitted.status !== 201) return { submitted, approved: null };
  const approved = await call(`/bulletin-versions/${submitted.body.version.bulletinVersionId}/approve`, {
    method: "POST", token: w.approver.token, company: w.co._id,
    body: { expectedRevision: submitted.body.version.revision },
  });
  return { submitted, approved };
}

const rebase = (w, fileId, body) =>
  call(`/engineering-files/${fileId}/rebase-source`, {
    method: "POST", token: w.maker.token, company: w.co._id, body,
  });

const reviewRebase = (w, fileId, body) =>
  call(`/engineering-files/${fileId}/rebase-review`, {
    method: "POST", token: w.maker.token, company: w.co._id, body,
  });

/** An approved IE version standing against R&D revision 1. */
async function throughFirstCycle(name, opts) {
  const w = await world(name, opts);
  const { fileId, rows } = await engineeringFile(w);
  const { submitted, approved } = await submitAndApprove(w, fileId);
  expect(submitted.status).toBe(201);
  expect(approved.status).toBe(200);
  return { w, fileId, rows, versionOneId: submitted.body.version.bulletinVersionId };
}

/* ═══ 1 · R&D CAN PUBLISH A SECOND REVISION AT ALL ═════════════════════════ */

describe("R&D's own lifecycle", () => {
  test("an approved technical record is reopened by Sales, for a stated reason", async () => {
    const w = await world("Reopen");
    asSales(w);

    const nothing = await techSheet(w, { action: "revise" });
    expect(nothing.status).toBe(400);
    expect(nothing.body.code).toBe("TECHNICAL_REVISION_REASON_REQUIRED");

    const reopened = await techSheet(w, { action: "revise", note: "Fabric changed." });
    expect(reopened.status).toBe(200);

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.techSheet.status).toBe("in_progress");
    expect(style.techSheet.technical.status).toBe("rework");
    expect(style.techSheet.technical.reopenReason).toBe("Fabric changed.");
    /* Server-stamped, never from the body. */
    expect(String(style.techSheet.technical.reopenedBy?.id || style.techSheet.technical.reopenedBy))
      .toContain(String(w.salesPerson.id));
    /* And revision 1 still says exactly what it said. */
    expect(style.techSheet.technicalRevisions).toHaveLength(1);
    expect(style.techSheet.technicalRevisions[0].outcome).toBe("approved");
    expect(style.techSheet.technicalRevisions[0].revision).toBe(1);
  });

  test("a record that is not approved is not reopened", async () => {
    const w = await world("ReopenTwice");
    asSales(w);
    expect((await techSheet(w, { action: "revise", note: "once" })).status).toBe(200);
    const again = await techSheet(w, { action: "revise", note: "again" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("TECHNICAL_RECORD_NOT_APPROVED");
  });

  test("an approved record cannot be edited until it is reopened", async () => {
    const w = await world("NoEdit");
    asSales(w);
    const refused = await rnd(`/${w.style._id}/technical`, {
      method: "PUT", token: w.salesPerson.token,
      body: { materials: [{ rawItemId: w.rawItemId, consumptionPerPiece: 9.9, unit: "m" }], requirements: [] },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("TECHNICAL_RECORD_NOT_EDITABLE");

    const stored = await SampleStyle.findById(w.style._id).lean();
    expect(stored.techSheet.technical.materials[0].consumptionPerPiece).toBe(1.4);
  });

  test("the whole second revision is published through mounted routes", async () => {
    const w = await world("Publish");
    const done = await publishNextRevision(w, { consumption: 1.6 });
    expect(done.status).toBe(200);

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.techSheet.technical.status).toBe("approved");
    expect(style.techSheet.technical.revision).toBe(2);
    expect(style.techSheet.technicalRevisions).toHaveLength(2);

    const [first, second] = style.techSheet.technicalRevisions;
    /* Revision 1, untouched, byte for byte in every field that matters. */
    expect(first.revision).toBe(1);
    expect(first.outcome).toBe("approved");
    expect(first.snapshot.materials[0].consumptionPerPiece).toBe(1.4);
    /* Revision 2, frozen with the new fact and its own decision. */
    expect(second.revision).toBe(2);
    expect(second.outcome).toBe("approved");
    expect(second.snapshot.materials[0].consumptionPerPiece).toBe(1.6);
    expect(second.decidedAt).toBeTruthy();
    expect(second.submittedAt).toBeTruthy();
  });

  test("the approval identity is the server's, whatever the body says", async () => {
    const w = await world("ForgedApprover");
    asSales(w);
    await techSheet(w, { action: "revise", note: "change" });
    await rnd(`/${w.style._id}/technical`, {
      method: "PUT", token: w.salesPerson.token,
      body: { materials: [{ rawItemId: w.rawItemId, rawItemName: "Shell fabric", consumptionPerPiece: 1.55, unit: "m", allowancePercent: 5, specification: "160gsm jersey" }], requirements: [] },
    });
    await techSheet(w, { action: "submit", file: { name: "t.pdf", url: "https://example.test/t.pdf" } });

    const forged = {
      action: "approve",
      note: "ok",
      decidedBy: { id: String(new mongoose.Types.ObjectId()), name: "Somebody Else" },
      decidedAt: "2020-01-01",
      revision: 99,
    };
    expect((await techSheet(w, forged)).status).toBe(200);

    const style = await SampleStyle.findById(w.style._id).lean();
    const second = style.techSheet.technicalRevisions.find((r) => r.revision === 2);
    expect(second).toBeTruthy();
    expect(String(second.decidedBy?.id)).toBe(String(w.salesPerson.id));
    expect(new Date(second.decidedAt).getFullYear()).toBeGreaterThan(2020);
    /* And no revision 99 was minted by a body that asked for one. */
    expect(style.techSheet.technicalRevisions.map((r) => r.revision)).toEqual([1, 2]);
  });
});

/* ═══ 2 · THE SUCCESSOR CYCLE ══════════════════════════════════════════════ */

describe("re-basing the engineering file", () => {
  test("with no newer R&D revision, the move is refused", async () => {
    const { w, fileId } = await throughFirstCycle("NoNewer");
    const file = await fileNow(w);

    const res = await rebase(w, fileId, { expectedRevision: file.revision });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe("IE_SOURCE_REBASE_NOT_REQUIRED");

    const stored = await IeStyleFile.findById(fileId).lean();
    expect(stored.sourceCycle).toBeUndefined();
  });

  test("an unapproved newer revision is not a source to move onto", async () => {
    const { w, fileId } = await throughFirstCycle("Unapproved");
    asSales(w);
    await techSheet(w, { action: "revise", note: "mid-flight" });

    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe("IE_SOURCE_VERSION_REQUIRED");
    expect((await IeStyleFile.findById(fileId).lean()).sourceCycle).toBeUndefined();
  });

  test("a newer approved revision opens a successor cycle", async () => {
    const { w, fileId, versionOneId } = await throughFirstCycle("Successor");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);

    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision, reason: "Fabric changed." });
    expect(res.status).toBe(200);
    expect(res.body.cycleNo).toBe(2);
    expect(res.body.fromRevision).toBe(1);
    expect(res.body.toRevision).toBe(2);

    const stored = await IeStyleFile.findById(fileId).lean();
    /* The ORIGINAL source is untouched — it is the provenance of the file and
       of every version already approved against it. */
    expect(stored.source.technicalRevision).toBe(1);
    expect(stored.source.snapshot.materials[0].consumptionPerPiece).toBe(1.4);
    /* And the cycle records what it moved onto and what it succeeded. */
    expect(stored.sourceCycle.cycleNo).toBe(2);
    expect(stored.sourceCycle.technicalRevision).toBe(2);
    expect(stored.sourceCycle.snapshot.materials[0].consumptionPerPiece).toBe(1.6);
    expect(stored.sourceCycle.predecessorTechnicalRevision).toBe(1);
    expect(String(stored.sourceCycle.predecessorVersionId)).toBe(String(versionOneId));
    expect(stored.sourceCycle.reason).toBe("Fabric changed.");
  });

  test("the approved version it succeeded is not touched by the move", async () => {
    const { w, fileId, versionOneId } = await throughFirstCycle("Immutable");
    const before = JSON.stringify(await IeBulletinVersion.findById(versionOneId).lean());

    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const file = await fileNow(w);
    expect((await rebase(w, fileId, { expectedRevision: file.revision })).status).toBe(200);

    const after = await IeBulletinVersion.findById(versionOneId).lean();
    expect(JSON.stringify(after)).toBe(before);
    /* Still approved, still readable, still naming revision 1 — which is what
       the costing that read it was quoting from. */
    expect(after.state).toBe("APPROVED");
    expect(after.technicalSource.technicalRevision).toBe(1);
    expect(after.technicalSource.snapshot.materials[0].consumptionPerPiece).toBe(1.4);
  });

  test("no approval carries forward", async () => {
    const { w, fileId, versionOneId } = await throughFirstCycle("NoCarry");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const file = await fileNow(w);
    await rebase(w, fileId, { expectedRevision: file.revision });

    /* The file still points at version 1 as its current approved bulletin —
       and that is correct: nothing has been approved against revision 2 yet.
       What the move must never do is mint or move an approval. */
    const stored = await IeStyleFile.findById(fileId).lean();
    expect(String(stored.currentApprovedBulletinVersionId)).toBe(String(versionOneId));
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: fileId, state: "APPROVED" })).toBe(1);
    expect(stored.sourceCycle.review.acknowledgedAt).toBeUndefined();
  });

  test("unchanged rows carry forward by their own identity", async () => {
    const { w, fileId, rows } = await throughFirstCycle("CarryForward");
    /* Only the material moves; the operations are word for word what they were. */
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);

    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(200);

    const after = await fileNow(w);
    expect(after.bulletin.rows.map((r) => r.rowId)).toEqual(rows.map((r) => r.rowId));
    expect(after.bulletin.rows.map((r) => r.proposedSamMinutes)).toEqual(rows.map((r) => r.proposedSamMinutes));
    /* No operation moved, so no row is in question — only the basis itself. */
    expect(res.body.reviewRequiredRowIds).toEqual([]);
    expect(res.body.changes.materials.changed[0].fields).toContain("consumptionPerPiece");
  });

  test("a changed operation puts its own row back in question, and blocks the submission", async () => {
    const { w, fileId, rows } = await throughFirstCycle("ChangedOp");
    expect((await publishNextRevision(w, {
      consumption: 1.4,
      operations: [
        { operationId: w.seamId, operationCode: "OP-SEAM", name: "Side seam", machineType: "SNLS", minutes: 2, seconds: 0, samMinutes: 2 },
        { operationId: w.hemId, operationCode: "OP-HEM", name: "Bottom hem", machineType: "FL", minutes: 0, seconds: 45, samMinutes: 0.75 },
      ],
    })).status).toBe(200);

    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(200);
    /* The seam row, and only the seam row. */
    const seam = rows.find((r) => r.operationCode === "OP-SEAM");
    expect(res.body.reviewRequiredRowIds).toEqual([seam.rowId]);

    const blocked = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: res.body.file.revision },
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.body.error.details.gapCodes).toContain("IE_SOURCE_REBASE_REVIEW_OUTSTANDING");
  });

  test("a changed allowance blocks the submission until the basis is acknowledged", async () => {
    const { w, fileId } = await throughFirstCycle("ChangedAllowance");
    expect((await publishNextRevision(w, { consumption: 1.4, allowance: 9 })).status).toBe(200);

    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision });
    expect(res.body.changes.materials.changed[0].fields).toContain("allowancePercent");

    const blocked = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: res.body.file.revision },
    });
    expect(blocked.body.error.details.gapCodes).toContain("IE_SOURCE_REBASE_REVIEW_OUTSTANDING");

    const reviewed = await reviewRebase(w, fileId, {
      expectedRevision: res.body.file.revision, acknowledgeSource: true,
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.acknowledged).toBe(true);

    const ok = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: reviewed.body.file.revision },
    });
    expect(ok.status).toBe(201);
  });

  test("the review names rows, and refuses rows this bulletin does not have", async () => {
    const { w, fileId } = await throughFirstCycle("ReviewRows");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const file = await fileNow(w);
    const res = await rebase(w, fileId, { expectedRevision: file.revision });

    const nonsense = await reviewRebase(w, fileId, {
      expectedRevision: res.body.file.revision, rowIds: ["row-that-does-not-exist"],
    });
    expect(nonsense.status).toBeGreaterThanOrEqual(400);
    expect(nonsense.body.error.code).toBe("IE_BULLETIN_ROW_NOT_FOUND");

    const empty = await reviewRebase(w, fileId, { expectedRevision: res.body.file.revision });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    expect(empty.body.error.code).toBe("VALIDATION");
  });

  test("two simultaneous moves produce one cycle", async () => {
    const { w, fileId } = await throughFirstCycle("Race");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const file = await fileNow(w);

    const [a, b] = await Promise.all([
      rebase(w, fileId, { expectedRevision: file.revision }),
      rebase(w, fileId, { expectedRevision: file.revision }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const stored = await IeStyleFile.findById(fileId).lean();
    expect(stored.sourceCycle.cycleNo).toBe(2);
    expect(stored.sourceCycle.technicalRevision).toBe(2);
    /* The loser was told which precondition failed, and wrote nothing. */
    const loser = a.status === 200 ? b : a;
    expect(["IE_FILE_REVISION_CONFLICT", "IE_SOURCE_REBASE_NOT_REQUIRED"]).toContain(loser.body.error.code);
  });

  test("a forged revision, snapshot or approver is refused or ignored", async () => {
    const { w, fileId } = await throughFirstCycle("Forged");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const file = await fileNow(w);

    for (const body of [
      { expectedRevision: file.revision, snapshot: { materials: [] } },
      { expectedRevision: file.revision, approvedAt: "2020-01-01" },
      { expectedRevision: file.revision, openedBy: String(new mongoose.Types.ObjectId()) },
      { expectedRevision: file.revision, cycleNo: 9 },
    ]) {
      const res = await rebase(w, fileId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }

    /* Naming a revision R&D does not stand behind is refused by name. */
    const wrong = await rebase(w, fileId, { expectedRevision: file.revision, technicalRevision: 99 });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body.error.code).toBe("IE_SOURCE_REBASE_REVISION_MISMATCH");

    expect((await IeStyleFile.findById(fileId).lean()).sourceCycle).toBeUndefined();

    /* And the honest one freezes the SERVER's copy of the revision. */
    const ok = await rebase(w, fileId, { expectedRevision: file.revision, technicalRevision: 2 });
    expect(ok.status).toBe(200);
    const stored = await IeStyleFile.findById(fileId).lean();
    expect(stored.sourceCycle.snapshot.materials[0].consumptionPerPiece).toBe(1.6);
    expect(new Date(stored.sourceCycle.approvedAt).getFullYear()).toBeGreaterThan(2020);
  });

  test("another company's file answers exactly as a missing one", async () => {
    const { w, fileId } = await throughFirstCycle("Foreign");
    const stranger = await world("Stranger");
    const outsider = await actor({ companies: [stranger.co], grants: { ie: "editor" } });

    const foreign = await call(`/engineering-files/${fileId}/rebase-source`, {
      method: "POST", token: outsider.token, company: stranger.co._id,
      body: { expectedRevision: 1 },
    });
    const missing = await call(`/engineering-files/${new mongoose.Types.ObjectId()}/rebase-source`, {
      method: "POST", token: outsider.token, company: stranger.co._id,
      body: { expectedRevision: 1 },
    });

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });
});

/* ═══ 3 · THE WHOLE CHAIN, END TO END ══════════════════════════════════════ */

describe("R&D revision 1 → IE version 1 → costing, and again", () => {
  test("the stale binding clears only when a successor version is approved", async () => {
    const { w, fileId, rows } = await throughFirstCycle("EndToEnd");

    /* 1–4 · bound to the first cycle. */
    const first = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(first.state).toBe("BOUND");
    expect(first.technical.materials[0].consumptionPerPiece).toBe(1.4);

    /* 5–6 · R&D moves, and the standing approval becomes a record rather than
       a basis. */
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);
    const stale = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(stale.state).toBe("IE_TECHNICAL_APPROVAL_STALE");
    expect(stale.confirmedRevision).toBe(1);
    expect(stale.currentRevision).toBe(2);

    /* 7 · IE moves onto it deliberately… */
    const file = await fileNow(w);
    const moved = await rebase(w, fileId, { expectedRevision: file.revision, reason: "New fabric." });
    expect(moved.status).toBe(200);

    /* …and the move alone changes nothing about what may be costed. */
    const stillStale = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(stillStale.state).toBe("IE_TECHNICAL_APPROVAL_STALE");

    /* 9 · reviewed, submitted, and approved by somebody else. */
    const reviewed = await reviewRebase(w, fileId, {
      expectedRevision: moved.body.file.revision,
      rowIds: rows.map((r) => r.rowId),
      acknowledgeSource: true,
    });
    expect(reviewed.status).toBe(200);

    /* Submitted by somebody who ALSO holds the approver role, so the refusal
       below is about the person and not about the rung they stand on. */
    const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: reviewed.body.file.revision },
    });
    expect(submitted.status).toBe(201);

    /* Maker-checker still decides who may approve it — a successor version is
       not approved by the person who proposed it, whatever moved R&D. */
    const self = await call(`/bulletin-versions/${submitted.body.version.bulletinVersionId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: submitted.body.version.revision },
    });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(self.body.error.code).toBe("IE_BULLETIN_VERSION_MAKER_CHECKER");
    expect((await IeBulletinVersion.findById(submitted.body.version.bulletinVersionId).lean()).state)
      .toBe("IN_REVIEW");

    const other = await actor({ companies: [w.co], grants: { ie: "approver" } });
    const approved = await call(`/bulletin-versions/${submitted.body.version.bulletinVersionId}/approve`, {
      method: "POST", token: other.token, company: w.co._id,
      body: { expectedRevision: submitted.body.version.revision },
    });
    expect(approved.status).toBe(200);

    /* 10 · and the binding is the NEW version's, with R&D's new figure. */
    const bound = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(bound.state).toBe("BOUND");
    expect(bound.technical.materials[0].consumptionPerPiece).toBe(1.6);

    /* 8 · while version 1 is still there, still approved-then-superseded, and
       still says what the first costing was built on. */
    const versions = await IeBulletinVersion.find({ ieStyleFileId: fileId }).sort({ versionNo: 1 }).lean();
    expect(versions).toHaveLength(2);
    expect(versions[0].state).toBe("SUPERSEDED");
    expect(versions[0].technicalSource.technicalRevision).toBe(1);
    expect(versions[0].technicalSource.snapshot.materials[0].consumptionPerPiece).toBe(1.4);
    expect(versions[1].state).toBe("APPROVED");
    expect(versions[1].technicalSource.technicalRevision).toBe(2);
    expect(versions[1].technicalSource.sourceCycleNo).toBe(2);
  });

  test("the source in force is one answer, wherever it is asked", async () => {
    /* Three readers — the readiness projection, the submission gates and the
       frozen source on a version — and one resolver behind them. */
    const { w, fileId } = await throughFirstCycle("OneAnswer");
    expect((await publishNextRevision(w, { consumption: 1.6 })).status).toBe(200);

    const before = await IeStyleFile.findById(fileId).lean();
    expect(styleFiles.currentSourceOf(before).technicalRevision).toBe(1);
    expect(styleFiles.currentSourceOf(before).cycleNo).toBe(1);

    const file = await fileNow(w);
    await rebase(w, fileId, { expectedRevision: file.revision });

    const after = await IeStyleFile.findById(fileId).lean();
    expect(styleFiles.currentSourceOf(after).technicalRevision).toBe(2);
    expect(styleFiles.currentSourceOf(after).cycleNo).toBe(2);
    /* And the readiness no longer reports the file as superseded, because it
       is not: it is on the revision R&D stands behind. */
    const read = await fileNow(w);
    expect(read.readiness.gaps.map((g) => g.code)).not.toContain("IE_SOURCE_VERSION_SUPERSEDED");
  });
});
