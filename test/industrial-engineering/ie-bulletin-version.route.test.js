// test/industrial-engineering/ie-bulletin-version.route.test.js
//
// IE CHUNK 7C1 — THE IMMUTABLE BULLETIN VERSION LIFECYCLE, AT THE WIRE.
//
// The Style File's embedded bulletin stays the one writable draft and keeps its
// existing writer; submit snapshots it and freezes it; return unfreezes it;
// approve makes the snapshot the file's current approved bulletin. The claims
// worth holding:
//
//   · a submitted snapshot is frozen from the INSTANT it exists, in every state,
//     through every Mongoose write method — not only once approved;
//   · the snapshot and the freeze commit together or not at all, so there is no
//     interleaving in which an IN_REVIEW version and an editable draft coexist;
//   · the draft's freeze is a stored field on the file, so the existing PATCH
//     enforces it in the same atomic filter that already enforces the revision;
//   · a return releases only the freeze that names its own version;
//   · only the approval transaction may move APPROVED to SUPERSEDED;
//   · every gate is collected, never the first failure alone;
//   · maker-checker compares actor ids, with no owner exemption;
//   · and without transactions all three commands fail closed, writing nothing.
//
// ── WHY THIS FILE RUNS ITS OWN DATABASE ─────────────────────────────────────
// `test/setup.js` starts a STANDALONE mongod, which accepts `startSession()` and
// then silently commits outside any transaction. Every command in this chunk
// writes two documents, so a standalone is exactly the deployment they refuse to
// run on. This file therefore skips the shared harness and starts a single-node
// REPLICA SET, which is the smallest deployment that commits two documents
// together. Test 21 forces the probe back to `false` to prove the closed door.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
/* Read by `test/setup.js` at the top of its own `beforeAll`, before this file's
   hooks run, so the shared standalone harness stands aside for the replica set
   below. Module bodies execute before any hook, so the flag is already set. */
process.env.TEST_WITHOUT_MONGO = "1";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

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
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");

const { transactionsAvailable, __setTransactionSupport } = require("../../services/storePurchase/unitOfWork.service");
const layouts = require("../../services/industrialEngineering/ieLineLayout.service");

let server, base, seq = 0;

let replSet;

beforeAll(async () => {
  /* One node is enough: transactions need a replica SET, not several members. */
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri(), { dbName: "ie_7c1_test" });

  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;

  /* The partial unique `IN_REVIEW` index is one of the two mechanisms that
     refuse a double submission, so it has to exist for this suite to mean
     anything. */
  await IeBulletinVersion.syncIndexes();
  await IeStyleFile.syncIndexes();
  await IeLineLayout.syncIndexes();
  await IeMethodStudy.syncIndexes();
  await IeOperation.syncIndexes();

  /* The probe memoises per process; settle it once, here, so no test pays for
     it and every test knows what it got. */
  expect(await transactionsAvailable()).toBe(true);
}, 300000);

afterEach(async () => {
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) await collections[key].deleteMany({});
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

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
  const email = `bv${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "B", lastName: `B${n}`, email, biometricId: `BV${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "B" });
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

  return {
    co, maker, approver, style, workOrder: wo,
    fileId: file.fileId, rows, operations,
    /* The exact garment SAM this world's layouts will freeze. */
    garmentSam: minutes.reduce((a, b) => a + b, 0),
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
  /* The response, plus the identities a caller needs to assert which study a
     snapshot bound. */
  approved.studyId = studyId;
  approved.submissionId = approved.body.submission.submissionId;
  approved.minutes = minutes;
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


/* ── THE FIVE 7C1 ROUTES, AND THE DRAFT'S ONE WRITER ─────────────────────── */

const submit = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin-versions`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const listVersions = (a, w, fileId, qs = "") => call(
  `/engineering-files/${fileId}/bulletin-versions${qs}`, { token: a.token, company: w.co._id },
);
const readVersion = (a, w, id) => call(`/bulletin-versions/${id}`, { token: a.token, company: w.co._id });
const returnVersion = (a, w, id, body) => call(`/bulletin-versions/${id}/return`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const approveVersion = (a, w, id, body) => call(`/bulletin-versions/${id}/approve`, {
  method: "POST", token: a.token, company: w.co._id, body,
});

/** The draft's ONE writer — the existing Chunk 3A route, unchanged. */
const patchBulletin = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const readFile = (a, w) => call(`/orders/${w.workOrder._id}/styles/${w.style._id}/engineering-file`, {
  token: a.token, company: w.co._id,
});

/** The file as stored, for the assertions about absent versus null. */
const storedFile = (w) => IeStyleFile.findById(w.fileId).lean();

/** A world whose bulletin is complete and submittable, plus its file revision. */
async function submittable(name, opts) {
  const w = await world(name, opts);
  const file = await readFile(w.maker, w);
  expect(file.status).toBe(200);
  return { w, file: file.body.file };
}

/** Submitted, and in review. */
async function inReview(name) {
  const { w, file } = await submittable(name);
  const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
  expect(res.status).toBe(201);
  return { w, file: res.body.file, version: res.body.version };
}

/** Submitted and approved by somebody other than the submitter. */
async function approved(name) {
  const { w, version } = await inReview(name);
  const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
    expectedRevision: version.revision,
  });
  expect(res.status).toBe(200);
  return { w, file: res.body.file, version: res.body.version };
}


/**
 * Every `bulletin*` / `currentApproved*` path a source file MUTATES.
 *
 * Scoped to the inside of `$set` and `$unset` blocks, with real brace matching,
 * because the same identifiers appear all over a published shape and in error
 * details — and those are reads. A scan that could not tell the two apart would
 * pass for the wrong reason.
 */
function mutatedPathsIn(source) {
  const found = [];
  for (const op of ["$set:", "$unset:"]) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(op, from);
      if (at === -1) break;
      const open = source.indexOf("{", at);
      if (open === -1) break;
      let depth = 0;
      let close = open;
      for (; close < source.length; close += 1) {
        if (source[close] === "{") depth += 1;
        else if (source[close] === "}") { depth -= 1; if (!depth) break; }
      }
      const block = source.slice(open, close);
      for (const m of block.matchAll(/(?:^|[\s{,])(bulletin[A-Za-z]*|currentApproved[A-Za-z]*)\s*:/g)) {
        found.push(m[1]);
      }
      from = close;
    }
  }
  return found;
}

/* ══ 1. THE DRAFT STILL HAS EXACTLY ONE WRITER ════════════════════════════ */

describe("the embedded bulletin is still the one writable draft", () => {
  test("no service other than the style file's own PATCH writes bulletin.rows", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/industrialEngineering");
    const writers = [];
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      /* A write to the draft is an assignment to the `bulletin.rows` path, which
         in this codebase only ever appears as a quoted `$set` key. */
      if (/["']bulletin\.rows["']\s*:/.test(src)) writers.push(name);
    }
    expect(writers).toEqual(["ieStyleFile.service.js"]);

    /* And the version service touches the draft nowhere at all. It READS
       `file.bulletin.rows` to take its snapshot; the only `bulletin*` paths it
       ever WRITES are the two review-pointer fields and the approved pointer. */
    const version = fs.readFileSync(path.join(dir, "ieBulletinVersion.service.js"), "utf8");
    expect(version).not.toMatch(/["']bulletin\.rows["']\s*:/);
    expect(version).not.toMatch(/\$set:\s*\{[^}]*\bbulletin:/);
    expect([...new Set(mutatedPathsIn(version))].sort()).toEqual([
      "bulletinReviewVersionId", "bulletinReviewVersionNo",
      "currentApprovedBulletinVersionId", "currentApprovedVersionNo",
    ]);
  });

  test("IeBulletinVersion has no DRAFT state, structurally", () => {
    expect(IeBulletinVersion.STATES).toEqual(["IN_REVIEW", "APPROVED", "RETURNED", "SUPERSEDED"]);
    expect(IeBulletinVersion.STATES).not.toContain("DRAFT");
    const enumerated = IeBulletinVersion.schema.path("state").enumValues;
    expect(enumerated).not.toContain("DRAFT");
    /* No index protects a state that cannot exist. */
    const partials = IeBulletinVersion.schema.indexes()
      .map(([, opts]) => opts?.partialFilterExpression?.state)
      .filter(Boolean);
    expect(partials).toEqual(["IN_REVIEW"]);
  });

  test("FILE_STATUS is untouched and the pointers are absent on a legacy file", async () => {
    expect(IeStyleFile.FILE_STATUS).toEqual(["DRAFT"]);
    const { w } = await submittable("Legacy");
    const raw = await storedFile(w);
    for (const field of [
      "bulletinReviewVersionId", "bulletinReviewVersionNo",
      "currentApprovedBulletinVersionId", "currentApprovedVersionNo",
    ]) {
      expect(field in raw).toBe(false);
    }
    /* An unrelated save must not fabricate nulls onto them. */
    await IeStyleFile.updateOne({ _id: w.fileId }, { $set: { updatedByName: "Somebody" } });
    const after = await storedFile(w);
    expect("bulletinReviewVersionId" in after).toBe(false);
    expect("currentApprovedVersionNo" in after).toBe(false);
  });
});

/* ══ 2. SUBMIT SNAPSHOTS AND FREEZES ══════════════════════════════════════ */

describe("submit snapshots the draft and freezes it", () => {
  test("the snapshot equals the draft field for field, with the approved evidence", async () => {
    const { w, file } = await submittable("Snapshot");
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const v = res.body.version;
    expect(v.versionNo).toBe(1);
    expect(v.state).toBe("IN_REVIEW");
    expect(v.revision).toBe(1);
    expect(v.fileRevisionAtSubmit).toBe(file.revision);
    expect(v.contentEditable).toBe(false);
    expect(v.isTerminal).toBe(false);
    expect(v.supersedesVersionNo).toBeNull();
    expect(v.history[0].type).toBe("BULLETIN_VERSION_SUBMITTED");

    /* Field for field against the draft. */
    expect(v.rows).toHaveLength(file.bulletin.rows.length);
    file.bulletin.rows.forEach((draft, i) => {
      const frozen = v.rows[i];
      expect(frozen.rowId).toBe(draft.rowId);
      expect(frozen.sequence).toBe(draft.sequence);
      expect(frozen.ieOperationId).toBe(draft.ieOperationId);
      expect(frozen.ieOperationRevision).toBe(draft.ieOperationRevision);
      expect(frozen.operationCode).toBe(draft.operationCode);
      expect(frozen.operationName).toBe(draft.operationName);
      expect(frozen.machineType).toBe(draft.machineType);
      expect(frozen.proposedSamMinutes).toBe(draft.proposedSamMinutes);
      expect(frozen.note).toBe(draft.note);
      expect(frozen.requirementSnapshot).toEqual(draft.requirementSnapshot);
    });

    /* And the approved evidence, resolved at submit. */
    for (const frozen of v.rows) {
      expect(typeof frozen.standardTimeMinutes).toBe("number");
      expect(frozen.standardTimeMinutes).toBeGreaterThan(0);
      expect(frozen.methodStudyId).toMatch(/^[0-9a-f]{24}$/);
      expect(frozen.approvedSubmissionId).toMatch(/^sub_/);
      expect(frozen.approvedAt).toBeTruthy();
    }
    /* Totals from the approved times, not the proposals. */
    expect(v.totals.samRowCount).toBe(4);
    expect(v.totals.garmentSamMinutes).toBe(4.5);
    expect(v.totals.samDerivation).toBe("SUM_OF_APPROVED_METHOD_STUDY_STANDARD_TIMES");
    /* Server-computed digests, agreeing with the layout service's own. */
    const own = layouts.sourceFingerprintOf(await frozenRowsOf(v.bulletinVersionId));
    expect(v.source.fingerprint).toBe(own);
    expect(v.source.approvalDigest).toBeTruthy();
  });

  test("the snapshot and the review pointer are present or absent together", async () => {
    const { w, file, version } = await inReview("Pointer");

    /* The pointer, on the file envelope the submit answered with… */
    expect(file.bulletinReviewVersionId).toBe(version.bulletinVersionId);
    expect(file.bulletinReviewVersionNo).toBe(1);
    expect(file.bulletinEditable).toBe(false);
    expect(file.revision).toBe(version.fileRevisionAtSubmit + 1);

    /* …and stored, beside exactly one version. */
    const raw = await storedFile(w);
    expect(String(raw.bulletinReviewVersionId)).toBe(version.bulletinVersionId);
    expect(raw.bulletinReviewVersionNo).toBe(1);
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId })).toBe(1);
    expect(raw.history.at(-1).type).toBe("BULLETIN_VERSION_SUBMITTED");

    /* Never one without the other: no file anywhere holds a pointer to a
       version that does not exist, and no IN_REVIEW version is unpointed. */
    const inReviewVersions = await IeBulletinVersion.find({ state: "IN_REVIEW" }).lean();
    for (const v of inReviewVersions) {
      const f = await IeStyleFile.findById(v.ieStyleFileId).lean();
      expect(String(f.bulletinReviewVersionId)).toBe(String(v._id));
    }
  });

  test("the draft is frozen: a PATCH answers IE_BULLETIN_VERSION_IN_REVIEW and changes nothing", async () => {
    const { w, version } = await inReview("Frozen");
    const before = await storedFile(w);

    const edited = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: before.revision,
      rows: before.bulletin.rows.slice(0, 2).map((r) => ({
        rowId: r.rowId, ieOperationId: String(r.ieOperationId),
        proposedSamMinutes: 9, note: "Edited under review",
      })),
    });
    expect(edited.status).toBe(409);
    expect(edited.body.error.code).toBe("IE_BULLETIN_VERSION_IN_REVIEW");
    expect(edited.body.error.details).toMatchObject({
      fileId: String(w.fileId),
      bulletinReviewVersionId: version.bulletinVersionId,
      bulletinReviewVersionNo: 1,
    });

    /* Byte-identical afterwards. */
    const after = await storedFile(w);
    expect(after.revision).toBe(before.revision);
    expect(JSON.stringify(after.bulletin.rows)).toBe(JSON.stringify(before.bulletin.rows));
    expect(after.history).toHaveLength(before.history.length);

    /* And a no-op PATCH is refused too, rather than reporting success. */
    const noop = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: before.revision,
      rows: before.bulletin.rows.map((r) => ({
        rowId: r.rowId, ieOperationId: String(r.ieOperationId),
        proposedSamMinutes: r.proposedSamMinutes, note: r.note,
      })),
    });
    expect(noop.status).toBe(409);
    expect(noop.body.error.code).toBe("IE_BULLETIN_VERSION_IN_REVIEW");
  });

/** The stored frozen rows, for re-deriving a digest the way the server does. */
async function frozenRowsOf(versionId) {
  const doc = await IeBulletinVersion.findById(versionId).lean();
  return doc.rows;
}

  test("the snapshot binds the LATER of two approvals, by the shared tie-break", async () => {
    /* Chunk 4B lets an already-approved row be re-timed and approved AGAIN, so a
       row can carry two approved studies. Which one is current is decided by
       `approvedTimesFor`'s `laterApproval` rule — newest `approved.at`, then the
       larger `_id` — and a version must bind exactly what a layout of the same
       source binds. A second resolver here would eventually disagree, and two
       records that disagree about which approval was current is the whole
       failure this reuse prevents. */
    const w = await world("TieBreak");
    const before = await readFile(w.maker, w);
    const firstRow = before.body.file.bulletin.rows[0];

    /* A second, later approval for row 0 at a different standard time. */
    const again = await approveAgain(w, 0, { minutes: 3.75 });
    expect(again.minutes).toBe(3.75);

    const file = await readFile(w.maker, w);
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.body.file.revision });
    expect(res.status).toBe(201);

    const frozen = res.body.version.rows.find((r) => r.rowId === firstRow.rowId);
    expect(frozen.standardTimeMinutes).toBe(3.75);
    expect(frozen.methodStudyId).toBe(again.studyId);
    expect(frozen.approvedSubmissionId).toBe(again.submissionId);

    /* And a layout opened from the same approved version binds the very same
       study — Chunk 7C2 opens layouts from the version, so it has to be
       approved before there is anything to open against. */
    const approvedVersion = await approveVersion(w.approver, w, res.body.version.bulletinVersionId, {
      expectedRevision: res.body.version.revision,
    });
    expect(approvedVersion.status).toBe(200);
    const opened = await openLayout(w.maker, w);
    expect(opened.status).toBe(201);
    const layoutRow = opened.body.layout.source.rows.find((r) => r.rowId === firstRow.rowId);
    expect(layoutRow.standardTimeMinutes).toBe(frozen.standardTimeMinutes);
    expect(layoutRow.methodStudyId).toBe(frozen.methodStudyId);
    /* Same evidence, so the same server-computed fingerprint. */
    expect(res.body.version.source.fingerprint).toBe(opened.body.layout.source.fingerprint);
  });
});

/* ══ 3. THE TWO RACES, AND THERE ARE ONLY TWO ═════════════════════════════ */

describe("a snapshot and an editable draft can never both exist", () => {
  test("PATCH first: submit conflicts and leaves no version behind", async () => {
    const { w, file } = await submittable("PatchFirst");
    const stale = file.revision;

    /* The edit commits between the caller reading the file and submitting it. */
    const edited = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: stale,
      rows: file.bulletin.rows.map((r, i) => ({
        rowId: r.rowId, ieOperationId: r.ieOperationId,
        proposedSamMinutes: i === 0 ? 7 : r.proposedSamMinutes, note: r.note,
      })),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.file.revision).toBe(stale + 1);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: stale });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_FILE_REVISION_CONFLICT");
    expect(res.body.error.details).toMatchObject({ expected: stale, actual: stale + 1 });

    /* ── AND NO ORPHAN ──────────────────────────────────────────────────
       The snapshot was created inside the transaction the file update aborted,
       so it is rolled back with it. */
    expect(await IeBulletinVersion.countDocuments({})).toBe(0);
    const raw = await storedFile(w);
    expect("bulletinReviewVersionId" in raw).toBe(false);

    /* And the draft is still editable. */
    const again = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: stale + 1,
      rows: file.bulletin.rows.map((r) => ({
        rowId: r.rowId, ieOperationId: r.ieOperationId,
        proposedSamMinutes: 3, note: r.note,
      })),
    });
    expect(again.status).toBe(200);
  });

  test("submit first: the PATCH conflicts and the rows stay byte-identical", async () => {
    const { w, file } = await submittable("SubmitFirst");
    const stale = file.revision;
    const before = await storedFile(w);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: stale });
    expect(res.status).toBe(201);

    const edited = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: stale,
      rows: file.bulletin.rows.map((r) => ({
        rowId: r.rowId, ieOperationId: r.ieOperationId, proposedSamMinutes: 7, note: "Too late",
      })),
    });
    expect(edited.status).toBe(409);
    expect(edited.body.error.code).toBe("IE_BULLETIN_VERSION_IN_REVIEW");

    const after = await storedFile(w);
    expect(JSON.stringify(after.bulletin.rows)).toBe(JSON.stringify(before.bulletin.rows));
  });

  test("two simultaneous submissions: exactly one version, refused by both mechanisms", async () => {
    const { w, file } = await submittable("DoubleSubmit");
    const [one, two] = await Promise.all([
      submit(w.maker, w, w.fileId, { expectedRevision: file.revision }),
      submit(w.maker, w, w.fileId, { expectedRevision: file.revision }),
    ]);
    const winners = [one, two].filter((r) => r.status === 201);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    /* Either mechanism may be the one that answered — the file filter or the
       partial unique index — and both refusals are truthful. */
    expect([409]).toContain(loser.status);
    expect(["IE_BULLETIN_VERSION_SUBMISSION_EXISTS", "IE_FILE_REVISION_CONFLICT"])
      .toContain(loser.body.error.code);

    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId })).toBe(1);
    expect(await IeBulletinVersion.countDocuments({ state: "IN_REVIEW" })).toBe(1);
  });

  test("a second submission while one is in review is refused by each mechanism independently", async () => {
    const { w, version } = await inReview("SecondSubmission");
    const raw = await storedFile(w);

    /* ── MECHANISM ONE: the file's own review pointer ─────────────────── */
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_SUBMISSION_EXISTS");
    expect(res.body.error.details).toMatchObject({
      bulletinReviewVersionId: version.bulletinVersionId, bulletinReviewVersionNo: 1,
    });

    /* ── MECHANISM TWO: the partial unique index, with the pointer removed
       so the first mechanism cannot be the one that answers ───────────── */
    await IeStyleFile.updateOne({ _id: w.fileId },
      { $unset: { bulletinReviewVersionId: "", bulletinReviewVersionNo: "" } });
    const direct = IeBulletinVersion.collection.insertOne({
      companyId: w.co._id, ieStyleFileId: new mongoose.Types.ObjectId(String(w.fileId)),
      sampleStyleId: w.style._id, versionNo: 99, state: "IN_REVIEW", revision: 1,
      fileRevisionAtSubmit: 1, rows: [], sourceFingerprint: "x", sourceApprovalDigest: "x",
      submittedBy: new mongoose.Types.ObjectId(), submittedAt: new Date(),
    });
    await expect(direct).rejects.toThrow(/E11000|duplicate key/i);
    expect(await IeBulletinVersion.countDocuments({ state: "IN_REVIEW" })).toBe(1);
  });

  test("version numbers come from the highest plus one, never a count", async () => {
    const { w, version } = await approved("Numbering");
    expect(version.versionNo).toBe(1);

    const raw = await storedFile(w);
    const second = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(second.status).toBe(201);
    expect(second.body.version.versionNo).toBe(2);
    /* And it names what it will supersede. */
    expect(second.body.version.supersedesVersionNo).toBe(1);

    /* With version 1 deleted, a COUNT would allocate 2 again. The highest plus
       one allocates 3, so a number is never reused and no gap hides one. */
    await IeBulletinVersion.deleteOne({ _id: version.bulletinVersionId });
    const r2 = await returnVersion(w.approver, w, second.body.version.bulletinVersionId, {
      expectedRevision: second.body.version.revision, reason: "Making room.",
    });
    expect(r2.status).toBe(200);
    const third = await submit(w.maker, w, w.fileId, { expectedRevision: r2.body.file.revision });
    expect(third.status).toBe(201);
    expect(third.body.version.versionNo).toBe(3);
  });
});

/* ══ 4. THE SNAPSHOT IS IMMUTABLE FROM THE INSTANT IT EXISTS ══════════════ */

describe("a submitted snapshot is frozen in every state, through every write path", () => {
  /** One version in each of the four states, on four separate files. */
  async function oneOfEach() {
    const reviewing = await inReview("FrozenInReview");

    const returning = await inReview("FrozenReturned");
    const ret = await returnVersion(returning.w.approver, returning.w,
      returning.version.bulletinVersionId,
      { expectedRevision: returning.version.revision, reason: "Not yet." });
    expect(ret.status).toBe(200);

    const approving = await approved("FrozenApproved");

    /* A SUPERSEDED one: approve a second version on the same file. */
    const raw = await storedFile(approving.w);
    const second = await submit(approving.w.maker, approving.w, approving.w.fileId,
      { expectedRevision: raw.revision });
    expect(second.status).toBe(201);
    const ok = await approveVersion(approving.w.approver, approving.w,
      second.body.version.bulletinVersionId, { expectedRevision: second.body.version.revision });
    expect(ok.status).toBe(200);

    return {
      IN_REVIEW: reviewing.version.bulletinVersionId,
      RETURNED: ret.body.version.bulletinVersionId,
      SUPERSEDED: approving.version.bulletinVersionId,
      APPROVED: second.body.version.bulletinVersionId,
    };
  }

  test("every content write is refused, in all four states and by all five methods", async () => {
    const ids = await oneOfEach();
    for (const [state, id] of Object.entries(ids)) {
      const before = await IeBulletinVersion.findById(id).lean();
      expect(before.state).toBe(state);

      /* ── save() ── */
      const doc = await IeBulletinVersion.findById(id);
      doc.rows[0].standardTimeMinutes = 99;
      await expect(doc.save()).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      const totalsDoc = await IeBulletinVersion.findById(id);
      totalsDoc.totals.garmentSamMinutes = 1;
      await expect(totalsDoc.save()).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      /* ── updateOne ── */
      await expect(IeBulletinVersion.updateOne({ _id: id }, { $set: { rows: [] } }))
        .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
      await expect(IeBulletinVersion.updateOne({ _id: id },
        { $set: { "rows.0.standardTimeMinutes": 99 } })).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      /* ── updateMany ── */
      await expect(IeBulletinVersion.updateMany({ _id: id },
        { $set: { sourceFingerprint: "forged" } })).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      /* ── findOneAndUpdate — the path a `pre("save")` hook never sees ── */
      await expect(IeBulletinVersion.findOneAndUpdate({ _id: id },
        { $set: { rows: [], totals: { garmentSamMinutes: 0 } } })).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
      await expect(IeBulletinVersion.findOneAndUpdate({ _id: id },
        { $set: { versionNo: 44 } })).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
      await expect(IeBulletinVersion.findOneAndUpdate({ _id: id },
        { $set: { submittedBy: new mongoose.Types.ObjectId() } })).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      /* ── replaceOne ── */
      await expect(IeBulletinVersion.replaceOne({ _id: id }, { ...before, rows: [] }))
        .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

      /* Nothing moved. */
      const after = await IeBulletinVersion.findById(id).lean();
      expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
      expect(after.revision).toBe(before.revision);
      expect(after.sourceFingerprint).toBe(before.sourceFingerprint);
      expect(after.state).toBe(before.state);
    }
  });

  test("an upsert cannot mint a version, and the terminal states take no transition either", async () => {
    const ids = await oneOfEach();
    await expect(IeBulletinVersion.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId() }, { $set: { state: "APPROVED" } }, { upsert: true },
    )).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

    /* RETURNED and SUPERSEDED are terminal: no command reaches them, and the
       service refuses before any write. */
    for (const state of ["RETURNED", "SUPERSEDED"]) {
      const doc = await IeBulletinVersion.findById(ids[state]).lean();
      const w = await IeStyleFile.findById(doc.ieStyleFileId).lean();
      void w;
      expect(IeBulletinVersion.TERMINAL.has(doc.state)).toBe(true);
    }
  });

  test("only the approval transaction may move APPROVED to SUPERSEDED", async () => {
    const { version } = await approved("OnlyApproval");
    const id = version.bulletinVersionId;

    /* The guard permits supersession by NAMING its two fields, so a write that
       claims a successor AND touches anything else is refused… */
    await expect(IeBulletinVersion.findOneAndUpdate({ _id: id },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, rows: [] } }))
      .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
    await expect(IeBulletinVersion.findOneAndUpdate({ _id: id },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, approvedByName: "Nobody" } }))
      .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
    /* …and so is a state move dressed as something else. A return's field set
       is a return's field set whatever state the document is in, so the field
       allowlist alone cannot catch this one: what catches it is the requirement
       that a state change NAME the state it moves from. */
    await expect(IeBulletinVersion.updateOne({ _id: id },
      { $set: { state: "RETURNED", returnReason: "Rewriting history" } }))
      .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
    /* Naming it honestly does not help: APPROVED to RETURNED is not a move. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "APPROVED" },
      { $set: { state: "RETURNED", returnReason: "Rewriting history" } }))
      .rejects.toThrow(/cannot move from APPROVED to RETURNED/);
    /* Nor does an `$in` that would be legal from one member and not the other. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: { $in: ["APPROVED", "IN_REVIEW"] } },
      { $set: { state: "RETURNED" } }))
      .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });

    /* ── AND THE SUPERSESSION MOVE ITSELF, DIRECTLY, IS REFUSED ──────────
       CORRECTED after review. This assertion used to perform the move by hand
       and expect it to succeed, on the grounds that the field names were the
       permitted ones. That was the hole: supersession is not a field set, it is
       something the approval transaction does while it also approves a
       successor, clears the review pointer and re-points the file. A write that
       does only the first of those, outside any transaction, leaves the file
       naming an approved version that is no longer approved. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "APPROVED" },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } }))
      .rejects.toThrow(/inside a transaction/i);
    await expect(IeBulletinVersion.findOneAndUpdate({ _id: id, state: "APPROVED" },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } }))
      .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
    /* Nothing moved: it is still the approved version. */
    const untouched = await IeBulletinVersion.findById(id).lean();
    expect(untouched.state).toBe("APPROVED");
    expect(untouched.supersededByVersionNo).toBeNull();

    const still = await IeBulletinVersion.findById(id).lean();
    expect(still.state).toBe("APPROVED");
    expect(still.supersededByVersionNo).toBeNull();
  });

  test("no update filter in the service omits a state clause", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/industrialEngineering/ieBulletinVersion.service.js"), "utf8");

    /* Every mutation of this collection, and each one's filter. */
    const mutations = [...src.matchAll(
      /IeBulletinVersion\.(findOneAndUpdate|updateOne|updateMany|replaceOne|deleteOne|deleteMany)\(/g)];
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      /* The filter is the first argument: read from the call's open paren to the
         end of that object literal. */
      const open = src.indexOf("{", m.index);
      let depth = 0;
      let close = open;
      for (; close < src.length; close += 1) {
        if (src[close] === "{") depth += 1;
        else if (src[close] === "}") { depth -= 1; if (!depth) break; }
      }
      const filter = src.slice(open, close + 1);
      expect(filter).toMatch(/state:/);
    }
    /* And nothing deletes a version at all. */
    expect(src).not.toMatch(/IeBulletinVersion\.(deleteOne|deleteMany|findOneAndDelete)\(/);
  });
});

/* ══ 5. RETURN UNFREEZES, AND RELEASES ONLY ITS OWN FREEZE ════════════════ */

describe("return is terminal and gives the draft back", () => {
  test("the pointer is cleared and the same PATCH then succeeds", async () => {
    const { w, version } = await inReview("Return");
    const res = await returnVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision, reason: "Row 3 needs a re-timed study.",
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.version.state).toBe("RETURNED");
    expect(res.body.version.revision).toBe(2);
    expect(res.body.version.returnReason).toBe("Row 3 needs a re-timed study.");
    expect(res.body.version.reviewedByName).toBeTruthy();
    expect(res.body.version.isTerminal).toBe(true);

    /* The freeze is gone, on the envelope and in storage. */
    expect(res.body.file.bulletinReviewVersionId).toBeNull();
    expect(res.body.file.bulletinReviewVersionNo).toBeNull();
    expect(res.body.file.bulletinEditable).toBe(true);
    const raw = await storedFile(w);
    expect("bulletinReviewVersionId" in raw).toBe(false);
    expect("bulletinReviewVersionNo" in raw).toBe(false);
    /* Returning approves nothing: the file has no approved version. */
    expect("currentApprovedBulletinVersionId" in raw).toBe(false);

    /* And the draft is editable again. */
    const edited = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: raw.revision,
      rows: raw.bulletin.rows.map((r) => ({
        rowId: r.rowId, ieOperationId: String(r.ieOperationId),
        proposedSamMinutes: 6, note: "Re-timed",
      })),
    });
    expect(edited.status).toBe(200);
  });

  test("a return for one version cannot clear another version's pointer", async () => {
    /* The freeze on a file belongs to ONE version. A return that released a
       freeze it does not own would unfreeze a draft while the version actually
       holding it still claimed to.

       Constructed within one company, because company scope must not be the
       thing doing the work here: the file is made to name a DIFFERENT version,
       and the return of this one must then release nothing. The route cannot
       express this, so the pointer is moved directly. */
    const { w, version } = await inReview("ReturnPredicate");
    const otherVersionId = new mongoose.Types.ObjectId();
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.fileId)) },
      { $set: { bulletinReviewVersionId: otherVersionId, bulletinReviewVersionNo: 99 } },
    );

    const res = await returnVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision, reason: "Trying to release somebody else's freeze.",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_TRANSITION_INVALID");

    /* The freeze is intact and still names the other version. */
    const raw = await storedFile(w);
    expect(String(raw.bulletinReviewVersionId)).toBe(String(otherVersionId));
    expect(raw.bulletinReviewVersionNo).toBe(99);

    /* And the whole transaction rolled back: the version is still IN_REVIEW at
       revision 1, with no return recorded against it. */
    const still = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(still.state).toBe("IN_REVIEW");
    expect(still.revision).toBe(1);
    expect(still.returnReason).toBe("");
    expect(still.reviewedBy).toBeNull();
    expect(still.history).toHaveLength(1);
  });

  test("an approval cannot clear another version's pointer either", async () => {
    const { w, version } = await inReview("ApprovePredicate");
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.fileId)) },
      { $set: { bulletinReviewVersionId: new mongoose.Types.ObjectId(), bulletinReviewVersionNo: 99 } },
    );

    const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_TRANSITION_INVALID");

    /* Nothing approved, nothing pointed at, nothing superseded. */
    const still = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(still.state).toBe("IN_REVIEW");
    expect(still.approvedBy).toBeNull();
    const raw = await storedFile(w);
    expect("currentApprovedBulletinVersionId" in raw).toBe(false);
  });

  test("a return needs a reason", async () => {
    const { w, version } = await inReview("ReturnReason");
    for (const body of [
      { expectedRevision: version.revision },
      { expectedRevision: version.revision, reason: "" },
      { expectedRevision: version.revision, reason: "   " },
    ]) {
      const res = await returnVersion(w.approver, w, version.bulletinVersionId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_REVIEW_REASON_REQUIRED");
      expect(res.body.error.details.fieldErrors[0].field).toBe("reason");
    }
    /* Nothing was written. */
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(stored.state).toBe("IN_REVIEW");
    expect(stored.revision).toBe(1);
  });

  test("a returned version is evidence and is never reopened", async () => {
    const { w, version } = await inReview("Reopen");
    const ret = await returnVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision, reason: "No.",
    });
    expect(ret.status).toBe(200);

    for (const [fn, body] of [
      [returnVersion, { expectedRevision: 2, reason: "Again." }],
      [approveVersion, { expectedRevision: 2 }],
    ]) {
      const res = await fn(w.approver, w, version.bulletinVersionId, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_TRANSITION_INVALID");
      expect(res.body.error.details.state).toBe("RETURNED");
      expect(res.body.error.message).toMatch(/final/i);
    }

    /* The way forward is a NEW version, and it is version 2. */
    const raw = await storedFile(w);
    const again = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(again.status).toBe(201);
    expect(again.body.version.versionNo).toBe(2);
  });
});

/* ══ 6. APPROVE ═══════════════════════════════════════════════════════════ */

describe("approve makes the snapshot the file's current bulletin", () => {
  test("the freeze is cleared and the approved pointer set in one file update", async () => {
    const { w, version } = await inReview("Approve");
    const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.version.state).toBe("APPROVED");
    expect(res.body.version.revision).toBe(2);
    expect(res.body.version.approvedByName).toBeTruthy();
    expect(res.body.version.approvedAt).toBeTruthy();
    expect(res.body.supersededVersionNo).toBeUndefined();

    expect(res.body.file.bulletinReviewVersionId).toBeNull();
    expect(res.body.file.currentApprovedBulletinVersionId).toBe(version.bulletinVersionId);
    expect(res.body.file.currentApprovedVersionNo).toBe(1);
    expect(res.body.file.bulletinEditable).toBe(true);

    /* ── BOTH LAND OR NEITHER DOES ──────────────────────────────────────
       A file pointing at an unapproved version, an approved version the file
       does not point at, and a cleared freeze with no new pointer must each be
       unreachable. */
    const raw = await storedFile(w);
    expect("bulletinReviewVersionId" in raw).toBe(false);
    expect(String(raw.currentApprovedBulletinVersionId)).toBe(version.bulletinVersionId);
    expect(raw.currentApprovedVersionNo).toBe(1);
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(stored.state).toBe("APPROVED");
    expect(raw.history.at(-1).type).toBe("BULLETIN_VERSION_APPROVED");
  });

  test("approving a second version supersedes the first and re-points the file", async () => {
    const { w, version: first } = await approved("Supersede");
    const raw = await storedFile(w);

    const second = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(second.body.version.supersedesVersionNo).toBe(1);
    const res = await approveVersion(w.approver, w, second.body.version.bulletinVersionId, {
      expectedRevision: second.body.version.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.supersededVersionNo).toBe(1);

    const older = await IeBulletinVersion.findById(first.bulletinVersionId).lean();
    expect(older.state).toBe("SUPERSEDED");
    expect(older.supersededByVersionNo).toBe(2);
    expect(older.history.at(-1).type).toBe("BULLETIN_VERSION_SUPERSEDED");
    /* Its CONTENT is untouched: superseding is not rewriting. */
    expect(older.rows).toHaveLength(4);
    expect(older.totals.garmentSamMinutes).toBe(4.5);

    /* Exactly one approved version, and the file names it. */
    const after = await storedFile(w);
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId, state: "APPROVED" })).toBe(1);
    expect(String(after.currentApprovedBulletinVersionId)).toBe(second.body.version.bulletinVersionId);
    expect(after.currentApprovedVersionNo).toBe(2);
  });

  test("editing after approval changes only the draft", async () => {
    const { w, version } = await approved("EditAfter");
    const frozen = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    const raw = await storedFile(w);

    const edited = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: raw.revision,
      rows: raw.bulletin.rows.slice(0, 3).map((r) => ({
        rowId: r.rowId, ieOperationId: String(r.ieOperationId),
        proposedSamMinutes: 2, note: "Successor draft",
      })),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.file.bulletin.rows).toHaveLength(3);
    /* The approved pointer survives an edit of the successor draft. */
    expect(edited.body.file.currentApprovedVersionNo).toBe(1);

    const after = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(frozen));
  });

  test("two simultaneous approvals: one commits, one conflicts", async () => {
    const { w, version } = await inReview("ApproveRace");
    const other = await approverIn(w.co);
    const [one, two] = await Promise.all([
      approveVersion(w.approver, w, version.bulletinVersionId, { expectedRevision: version.revision }),
      approveVersion(other, w, version.bulletinVersionId, { expectedRevision: version.revision }),
    ]);
    const winners = [one, two].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(["IE_BULLETIN_VERSION_REVISION_CONFLICT", "IE_BULLETIN_VERSION_TRANSITION_INVALID"])
      .toContain(loser.body.error.code);

    /* One pointer written, one approval event, one revision move. */
    const raw = await storedFile(w);
    expect(raw.currentApprovedVersionNo).toBe(1);
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(stored.revision).toBe(2);
    expect(stored.history.filter((e) => e.type === "BULLETIN_VERSION_APPROVED")).toHaveLength(1);
  });

  test("approval racing a return: whichever commits first decides", async () => {
    const { w, version } = await inReview("ApproveVsReturn");
    const other = await approverIn(w.co);
    const [app, ret] = await Promise.all([
      approveVersion(w.approver, w, version.bulletinVersionId, { expectedRevision: version.revision }),
      returnVersion(other, w, version.bulletinVersionId, {
        expectedRevision: version.revision, reason: "Returning instead.",
      }),
    ]);
    const winners = [app, ret].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [app, ret].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(["IE_BULLETIN_VERSION_REVISION_CONFLICT", "IE_BULLETIN_VERSION_TRANSITION_INVALID"])
      .toContain(loser.body.error.code);

    /* The version left IN_REVIEW exactly once, and the freeze was cleared once. */
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(["APPROVED", "RETURNED"]).toContain(stored.state);
    expect(stored.revision).toBe(2);
    const raw = await storedFile(w);
    expect("bulletinReviewVersionId" in raw).toBe(false);
  });

  test("expectedRevision conflicts on submit, return and approve", async () => {
    const { w, file } = await submittable("Expected");
    const bad = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision + 5 });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("IE_FILE_REVISION_CONFLICT");
    expect(await IeBulletinVersion.countDocuments({})).toBe(0);

    const ok = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    const id = ok.body.version.bulletinVersionId;
    for (const [fn, body, code] of [
      [returnVersion, { expectedRevision: 9, reason: "Stale." }, "IE_BULLETIN_VERSION_REVISION_CONFLICT"],
      [approveVersion, { expectedRevision: 9 }, "IE_BULLETIN_VERSION_REVISION_CONFLICT"],
    ]) {
      const res = await fn(w.approver, w, id, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.details).toMatchObject({ expected: 9, actual: 1 });
    }
    /* And a missing one is a typed validation refusal, not a guess. */
    for (const [fn, body] of [[returnVersion, { reason: "No revision." }], [approveVersion, {}]]) {
      const res = await fn(w.approver, w, id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.fieldErrors[0].field).toBe("expectedRevision");
    }
    /* An approval carries no reason, and says so rather than ignoring one. */
    const stray = await approveVersion(w.approver, w, id, { expectedRevision: 1, reason: "Looks fine" });
    expect(stray.status).toBe(400);
    expect(stray.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    expect(stray.body.error.details.field).toBe("reason");
  });
});

/* ══ 7. THE GATES, AND MAKER-CHECKER ══════════════════════════════════════ */

describe("every readiness gate refuses, and the payload lists them all", () => {
  test("an empty bulletin cannot be submitted", async () => {
    const w = await world("Empty", { approveAll: false });
    const file = await readFile(w.maker, w);
    const cleared = await patchBulletin(w.maker, w, w.fileId, {
      expectedRevision: file.body.file.revision, rows: [],
    });
    expect(cleared.status).toBe(200);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: cleared.body.file.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    expect(res.body.error.details.gapCodes).toContain("IE_BULLETIN_EMPTY");
    expect(await IeBulletinVersion.countDocuments({})).toBe(0);
  });

  test("a row with no approved method study cannot be submitted", async () => {
    /* `approveAll: false` leaves the last row without an approved study. */
    const w = await world("NoStudy", { approveAll: false });
    const file = await readFile(w.maker, w);
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.body.file.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    const miss = res.body.error.details.gaps.find((g) => g.code === "IE_BULLETIN_ROW_NO_APPROVED_TIME");
    expect(miss).toBeTruthy();
    expect(miss.reason).toBe("NO_APPROVED_METHOD_STUDY");
    expect(miss.owner).toBe("INDUSTRIAL_ENGINEERING");
    expect(miss.action).toBe("APPROVE_METHOD_STUDY");
    expect(await IeBulletinVersion.countDocuments({})).toBe(0);
  });

  test("a retired operation refuses approval, with no override at this gate", async () => {
    const { w, version } = await inReview("RetiredAtApproval");
    /* Retired AFTER submission — which is exactly why the gates run twice. */
    const op = w.operations[0];
    const retired = await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: { expectedRevision: op.revision },
    });
    expect(retired.status).toBe(200);

    const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    const gap = res.body.error.details.gaps
      .find((g) => g.code === "IE_BULLETIN_VERSION_OPERATION_RETIRED");
    expect(gap).toBeTruthy();
    expect(gap.operationCodes).toContain(op.code);
    expect(gap.message).toMatch(/no override at this gate/i);

    /* No override field is accepted, by any name. */
    for (const extra of [{ override: true }, { overrideReason: "Needed anyway" }, { force: true }]) {
      const forced = await approveVersion(w.approver, w, version.bulletinVersionId, {
        expectedRevision: version.revision, ...extra,
      });
      expect(forced.status).toBe(400);
      expect(forced.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }

    /* Nothing moved, and the draft is still frozen by the submission. */
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(stored.state).toBe("IN_REVIEW");
    const raw = await storedFile(w);
    expect(String(raw.bulletinReviewVersionId)).toBe(version.bulletinVersionId);
  });

  test("a superseded R&D source refuses, and the payload lists ALL failures at once", async () => {
    const { w, version } = await inReview("AllGaps");

    /* Two things go wrong at once: an operation is retired and R&D approves a
       newer technical revision. A payload naming only the first would send an
       engineer round the loop twice. */
    const op = w.operations[1];
    expect((await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: { expectedRevision: op.revision },
    })).status).toBe(200);
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "techSheet.technical.revision": 4 },
      $push: {
        "techSheet.technicalRevisions": {
          revision: 4, submittedAt: new Date("2026-09-01"), outcome: "approved",
          decidedAt: new Date("2026-09-02"),
          snapshot: { revision: 4, materials: [], requirements: [], operations: [] },
        },
      },
    });

    const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    const codes = res.body.error.details.gapCodes;
    expect(codes).toContain("IE_BULLETIN_VERSION_OPERATION_RETIRED");
    expect(codes).toContain("IE_SOURCE_VERSION_SUPERSEDED");
    expect(codes.length).toBeGreaterThanOrEqual(2);
    /* Every gap carries the four fields a screen needs. */
    for (const g of res.body.error.details.gaps) {
      expect(typeof g.code).toBe("string");
      expect(typeof g.message).toBe("string");
      expect(g.owner).toBeTruthy();
      expect(typeof g.action).toBe("string");
    }
  });

  test("a duplicate row refuses, and names the rows", async () => {
    const { w, file } = await submittable("Duplicate");
    /* The draft's own writer refuses duplicates, so this is constructed
       directly — the gate has to hold whatever put the rows there. */
    const raw = await storedFile(w);
    await IeStyleFile.collection.updateOne({ _id: raw._id }, {
      $push: { "bulletin.rows": raw.bulletin.rows[0] },
    });
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(409);
    const gap = res.body.error.details.gaps.find((g) => g.code === "IE_BULLETIN_ROW_DUPLICATE");
    expect(gap).toBeTruthy();
    expect(gap.rowIds).toEqual([raw.bulletin.rows[0].rowId]);
  });

  test("maker-checker compares ids, with no owner or administrator exemption", async () => {
    const { w, version } = await inReview("MakerChecker");

    /* A plain editor is stopped by the ROLE: they may not decide at all. */
    const selfApprove = await approveVersion(w.maker, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe("IE_WRITE_FORBIDDEN");

    /* ── AND NOW THE REAL CASE ──────────────────────────────────────────
       One person who both submitted and holds the approver role. The role is
       satisfied, so only the identity comparison can refuse them — and it does.
       An owner and a platform administrator are refused on the same terms;
       there is no exemption to hold a role against. */
    const own = await submittable("MakerCheckerSelf");
    const both = await actor({ companies: [own.w.co], grants: { ie: "approver" } });
    const submitted = await submit(both, own.w, own.w.fileId, { expectedRevision: own.file.revision });
    expect(submitted.status).toBe(201);

    const res = await approveVersion(both, own.w, submitted.body.version.bulletinVersionId, {
      expectedRevision: submitted.body.version.revision,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_MAKER_CHECKER");
    expect(res.body.error.message).toMatch(/somebody other than the person who submitted/i);

    /* ── COMPARED BY ID ─────────────────────────────────────────────────
       The stored `submittedBy` is an ObjectId, and the refusal turns on it.
       Somebody else approves the very same version without difficulty. */
    const stored = await IeBulletinVersion.findById(submitted.body.version.bulletinVersionId).lean();
    expect(stored.submittedBy).toBeInstanceOf(mongoose.Types.ObjectId);
    const someoneElse = await approverIn(own.w.co);
    const ok = await approveVersion(someoneElse, own.w, submitted.body.version.bulletinVersionId, {
      expectedRevision: submitted.body.version.revision,
    });
    expect(ok.status).toBe(200);

    /* And the comparison in the source is of ids, never of display names. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/industrialEngineering/ieBulletinVersion.service.js"), "utf8");
    expect(src).toMatch(/String\(current\.submittedBy\)\s*===\s*String\(approver\)/);
    expect(src).not.toMatch(/submittedByName\s*===/);

    /* Nothing was written by the refused attempt. */
    const untouched = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(untouched.state).toBe("IN_REVIEW");
  });
});

/* ══ 8. COMPANY AND ROLE BOUNDARIES ═══════════════════════════════════════ */

describe("company scope and roles", () => {
  test("another company's file and version are indistinguishable from absent", async () => {
    const mine = await inReview("IsolationMine");
    const theirs = await world("IsolationTheirs");
    const outsider = await approverIn(theirs.co);
    const t = { token: outsider.token, company: theirs.co._id };
    const id = mine.version.bulletinVersionId;

    const read = await call(`/bulletin-versions/${id}`, t);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_FOUND");
    for (const other of [
      await call(`/bulletin-versions/${new mongoose.Types.ObjectId()}`, t),
      await call("/bulletin-versions/not-an-id", t),
    ]) {
      expect(other.status).toBe(read.status);
      expect(other.body.error.code).toBe(read.body.error.code);
      expect(other.body.error.message).toBe(read.body.error.message);
    }

    /* Both decisions say the same. */
    for (const [path, body] of [
      [`/bulletin-versions/${id}/return`, { expectedRevision: 1, reason: "Not mine." }],
      [`/bulletin-versions/${id}/approve`, { expectedRevision: 1 }],
    ]) {
      const res = await call(path, { method: "POST", body, ...t });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_FOUND");
    }

    /* Their file id is also not a way in. */
    const list = await call(`/engineering-files/${mine.w.fileId}/bulletin-versions`, t);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("IE_FILE_NOT_FOUND");
    const stolen = await call(`/engineering-files/${mine.w.fileId}/bulletin-versions`, { method: "POST", body: { expectedRevision: 1 }, ...t });
    expect(stolen.status).toBe(404);

    /* And nothing moved. */
    const stored = await IeBulletinVersion.findById(id).lean();
    expect(stored.state).toBe("IN_REVIEW");
    expect(stored.revision).toBe(1);
  });

  test("a viewer reads and cannot submit; an editor submits and cannot decide", async () => {
    const { w, version } = await inReview("Roles");
    const viewer = await viewerIn(w.co);
    const editor = await editorIn(w.co);

    for (const a of [viewer, editor, w.approver]) {
      expect((await readVersion(a, w, version.bulletinVersionId)).status).toBe(200);
      expect((await listVersions(a, w, w.fileId)).status).toBe(200);
    }

    /* A viewer proposes nothing. */
    const vs = await submit(viewer, w, w.fileId, { expectedRevision: 1 });
    expect(vs.status).toBe(403);
    expect(vs.body.error.code).toBe("IE_WRITE_FORBIDDEN");

    /* An editor decides nothing. */
    for (const [fn, body] of [
      [returnVersion, { expectedRevision: version.revision, reason: "Editor tried." }],
      [approveVersion, { expectedRevision: version.revision }],
    ]) {
      const res = await fn(editor, w, version.bulletinVersionId, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(stored.state).toBe("IN_REVIEW");
  });

  test("the list is this file's versions, newest first, and pages", async () => {
    const { w } = await approved("ListVersions");
    let raw = await storedFile(w);
    const second = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect((await returnVersion(w.approver, w, second.body.version.bulletinVersionId, {
      expectedRevision: 1, reason: "Second, returned.",
    })).status).toBe(200);
    raw = await storedFile(w);
    const third = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(third.status).toBe(201);

    const list = await listVersions(w.maker, w, w.fileId);
    expect(list.status).toBe(200);
    expect(list.body.versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    expect(list.body.versions.map((v) => v.state)).toEqual(["IN_REVIEW", "RETURNED", "APPROVED"]);
    expect(list.body.sort).toBe("versionNo:desc");
    /* The list omits the rows; a version's rows come from its own read. */
    expect(list.body.versions[0].rows).toBeUndefined();
    expect(list.body.versions[0].rowCount).toBe(4);
    expect((await readVersion(w.maker, w, third.body.version.bulletinVersionId)).body.version.rows)
      .toHaveLength(4);

    const filtered = await listVersions(w.maker, w, w.fileId, "?state=APPROVED");
    expect(filtered.body.versions.map((v) => v.versionNo)).toEqual([1]);
    const bad = await listVersions(w.maker, w, w.fileId, "?state=DRAFT");
    expect(bad.status).toBe(400);

    const paged = await listVersions(w.maker, w, w.fileId, "?limit=2");
    expect(paged.body.versions.map((v) => v.versionNo)).toEqual([3, 2]);
    expect(paged.body.hasMore).toBe(true);
    const next = await listVersions(w.maker, w, w.fileId, `?limit=2&cursor=${paged.body.nextCursor}`);
    expect(next.body.versions.map((v) => v.versionNo)).toEqual([1]);

    /* Another company's file cannot be listed through this route at all. */
    const theirs = await world("ListTheirs");
    const outsider = await viewerIn(theirs.co);
    expect((await listVersions(outsider, theirs, w.fileId)).status).toBe(404);
  });
});

/* ══ 9. WITHOUT TRANSACTIONS, ALL THREE FAIL CLOSED ═══════════════════════ */

describe("a deployment that cannot commit two documents writes neither", () => {
  test("submit, return and approve each answer 503 and write nothing", async () => {
    const { w, version } = await inReview("NoTxn");
    const beforeVersion = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    const beforeFile = await storedFile(w);
    const fresh = await submittable("NoTxnFresh");

    __setTransactionSupport(false);
    try {
      const attempts = [
        await submit(fresh.w.maker, fresh.w, fresh.w.fileId, { expectedRevision: fresh.file.revision }),
        await returnVersion(w.approver, w, version.bulletinVersionId, {
          expectedRevision: version.revision, reason: "No transactions.",
        }),
        await approveVersion(w.approver, w, version.bulletinVersionId, {
          expectedRevision: version.revision,
        }),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE");
        expect(res.body.error.details).toMatchObject({
          requires: "MONGODB_TRANSACTIONS", wrote: "NOTHING",
        });
      }
    } finally {
      __setTransactionSupport(true);
    }

    /* Nothing at all was written, by any of the three. */
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: fresh.w.fileId })).toBe(0);
    const rawFresh = await storedFile(fresh.w);
    expect("bulletinReviewVersionId" in rawFresh).toBe(false);
    expect(rawFresh.revision).toBe(fresh.file.revision);

    const afterVersion = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(JSON.stringify(afterVersion)).toBe(JSON.stringify(beforeVersion));
    const afterFile = await storedFile(w);
    expect(afterFile.revision).toBe(beforeFile.revision);
    expect(String(afterFile.bulletinReviewVersionId)).toBe(version.bulletinVersionId);

    /* And the door opens again once the deployment can. */
    const ok = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(ok.status).toBe(200);
  });

  test("the probe is consulted before any domain work", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/industrialEngineering/ieBulletinVersion.service.js"), "utf8");
    /* The repository's own probe, not a local reimplementation. */
    expect(src).toMatch(/require\("\.\.\/storePurchase\/unitOfWork\.service"\)/);
    expect(src).toMatch(/transactionsAvailable\(\)/);
    /* And no degraded fallback: there is no branch that proceeds without one. */
    expect(src).not.toMatch(/transactionMode|MARKED/);
    expect(src).not.toMatch(/if\s*\(\s*!?\s*session\s*\)\s*\{[^}]*await/);
  });
});

/* ══ 10. WHAT THIS CHUNK DOES NOT DO ══════════════════════════════════════ */

describe("the boundary holds", () => {
  test("a pre-7C1 layout stays readable and is not approvable", async () => {
    /* CORRECTED for Chunk 7C2, which made the open route refuse a file with no
       approved bulletin version. A pre-7C1 layout can therefore no longer be
       produced through the route at all — which is the point: it is a record
       that EXISTS from before, not one anybody can still create. So it is
       inserted as it actually looks, with neither version field present, and is
       proved readable and refused for approval by name.

       This is also why no backfill is approved anywhere: there is nothing
       truthful to put in those fields for a layout balanced against a bulletin
       nobody snapshotted. */
    const { w } = await submittable("PreLayout");
    const file = await IeStyleFile.findById(w.fileId).lean();
    const rows = (file.bulletin.rows || []).map((r, i) => ({
      rowId: r.rowId, sequence: i + 1,
      ieOperationId: r.ieOperationId, ieOperationRevision: r.ieOperationRevision,
      operationCode: r.operationCode, operationName: r.operationName,
      standardTimeMinutes: 1, standardTimeSource: "CALCULATED",
      requirementSnapshot: r.requirementSnapshot ?? null,
    }));
    const legacy = await IeLineLayout.collection.insertOne({
      companyId: w.co._id,
      ieStyleFileId: new mongoose.Types.ObjectId(String(w.fileId)),
      sampleStyleId: w.style._id,
      bulletinRevision: file.revision,
      sourceFingerprint: "f".repeat(64),
      sourceApprovalDigest: "a".repeat(64),
      sourceRequirementDigest: "",
      sourceRows: rows,
      status: "DRAFT",
      revision: 2,
      stations: [{
        stationId: "stn_legacy0000000001", sequence: 1, label: "Legacy line", note: "",
        plannedMachineTypes: [],
        assignments: rows.map((r, i) => ({
          rowId: r.rowId, sequence: i + 1,
          operationCode: r.operationCode, operationName: r.operationName,
          standardTimeMinutes: r.standardTimeMinutes,
        })),
      }],
      history: [],
      createdBy: new mongoose.Types.ObjectId(),
      createdByName: "Somebody, long ago",
      createdAt: new Date("2026-06-01"), updatedAt: new Date("2026-06-01"),
    });
    const layoutId = String(legacy.insertedId);

    /* Neither version field is present — which is what a legacy record is. */
    const stored = await IeLineLayout.findById(layoutId).lean();
    expect("ieBulletinVersionId" in stored).toBe(false);
    expect("bulletinVersionNo" in stored).toBe(false);

    /* Fully readable, with its stations, its frozen rows and its metrics. */
    const read = await call(`/line-layouts/${layoutId}`, { token: w.maker.token, company: w.co._id });
    expect(read.status).toBe(200);
    expect(read.body.layout.stations).toHaveLength(1);
    expect(read.body.layout.source.rows).toHaveLength(rows.length);
    expect(read.body.layout.versionBacked).toBe(false);
    expect(read.body.layout.bulletinVersion).toBeNull();
    /* And not labelled as something it is not. */
    expect(read.body.layout.canApprove).toBe(false);

    /* Approval is refused by its own code, and the resolution is a new layout
       rather than a wait for something that is not coming. */
    const attempt = await call(`/line-layouts/${layoutId}/approve`, {
      method: "POST", body: { expectedRevision: stored.revision },
      token: w.approver.token, company: w.co._id,
    });
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe("IE_LAYOUT_BULLETIN_VERSION_UNPROVEN");
    expect(attempt.body.error.details.resolution).toBe("OPEN_NEW_DRAFT_LAYOUT");

    /* Nothing was written, and no backfill happened on the way past. */
    const after = await IeLineLayout.findById(layoutId).lean();
    expect(after.status).toBe("DRAFT");
    expect(after.revision).toBe(stored.revision);
    expect("ieBulletinVersionId" in after).toBe(false);
    expect("approvedBy" in after).toBe(false);
  });

  test("no IE service imports a PPC model or writes a release", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/industrialEngineering");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      expect(src).not.toMatch(/models\/CMS_Models\/PPC/);
      expect(src).not.toMatch(/DownstreamHandoverReceipt/);
      expect(src).not.toMatch(/services\/ppc\//);
    }
  });

  test("the router gained exactly the five routes, and no release verb", () => {
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route)
      .filter((l) => String(l.route.path).includes("bulletin-versions"))
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(paths).toEqual([
      "GET /bulletin-versions/:versionId",
      "GET /engineering-files/:fileId/bulletin-versions",
      "POST /bulletin-versions/:versionId/approve",
      "POST /bulletin-versions/:versionId/return",
      "POST /engineering-files/:fileId/bulletin-versions",
    ]);

    /* And nothing anywhere on this router releases, acknowledges or books. */
    const all = router.stack.filter((l) => l.route).map((l) => l.route.path);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(all.filter((p) => /release|acknowledge|handover|receipt|publish-to|book/i.test(p)))
      .toEqual(["/style-files/:fileId/releases", "/releases/:releaseId/impact"]);
    expect(all.filter((p) => /bulletin-versions/.test(p) && /delete/i.test(p))).toEqual([]);
  });

  test("a version payload carries no Production, machine, operator or barcode concept", async () => {
    const { version } = await approved("CleanPayload");
    const wire = JSON.stringify(version);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "availability", "maintenanceStatus",
      "employeeId", "operatorId", "operatorIdentityId", "attendance", "shiftName",
      "barcodeId", "scanId", "barcodeScans", "workOrderId", "productionScheduleId",
      "releasedAt", "acknowledgedAt", "bookedQuantity", "deliveryDate",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });
});

/* ══ 11. THE FOUR CORRECTIONS ═════════════════════════════════════════════
 *
 * Codex found four holes behind a suite that was passing. Each is pinned here.
 */

describe("a submitted version changes only by making one of the three moves", () => {
  async function fourStates() {
    const reviewing = await inReview("GuardInReview");
    const returning = await inReview("GuardReturned");
    const ret = await returnVersion(returning.w.approver, returning.w,
      returning.version.bulletinVersionId,
      { expectedRevision: returning.version.revision, reason: "Not yet." });
    expect(ret.status).toBe(200);
    const approving = await approved("GuardApproved");
    const raw = await storedFile(approving.w);
    const second = await submit(approving.w.maker, approving.w, approving.w.fileId,
      { expectedRevision: raw.revision });
    expect((await approveVersion(approving.w.approver, approving.w,
      second.body.version.bulletinVersionId,
      { expectedRevision: second.body.version.revision })).status).toBe(200);
    return {
      IN_REVIEW: reviewing.version.bulletinVersionId,
      RETURNED: ret.body.version.bulletinVersionId,
      SUPERSEDED: approving.version.bulletinVersionId,
      APPROVED: second.body.version.bulletinVersionId,
    };
  }

  test("save() modifies nothing that already exists, in any state", async () => {
    const ids = await fourStates();
    for (const [state, id] of Object.entries(ids)) {
      /* Even a field the matching transition is allowed to write. A `save` has
         no filter, so it cannot prove which state it is moving from — and a
         transition that cannot prove that is not one of the three. */
      for (const mutate of [
        (d) => { d.returnReason = "By hand"; },
        (d) => { d.approvedByName = "By hand"; },
        (d) => { d.state = "SUPERSEDED"; },
        (d) => { d.revision += 1; },
        (d) => { d.history.push({ ...d.history[0].toObject(), eventId: "forged" }); },
      ]) {
        const doc = await IeBulletinVersion.findById(id);
        mutate(doc);
        await expect(doc.save()).rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
      }
      const after = await IeBulletinVersion.findById(id).lean();
      expect(after.state).toBe(state);
    }
    /* Creation is still how every snapshot comes into existence. */
    const { w, file } = await submittable("GuardCreate");
    expect((await submit(w.maker, w, w.fileId, { expectedRevision: file.revision })).status).toBe(201);
  });

  test("replaceOne, findOneAndReplace and updateMany are refused outright", async () => {
    const ids = await fourStates();
    for (const id of Object.values(ids)) {
      const doc = await IeBulletinVersion.findById(id).lean();
      await expect(IeBulletinVersion.replaceOne({ _id: id }, doc))
        .rejects.toThrow(/cannot be replaced/i);
      await expect(IeBulletinVersion.findOneAndReplace({ _id: id }, doc))
        .rejects.toThrow(/cannot be replaced/i);
      /* Refused even when it names a legal move: a transition happens to ONE
         version, and a bulk write cannot have proved the state of each. */
      await expect(IeBulletinVersion.updateMany({ _id: id, state: "IN_REVIEW" },
        { $set: { state: "RETURNED", returnReason: "In bulk" } }))
        .rejects.toThrow(/in bulk/i);
    }
  });

  test("a metadata-only write with no state move is refused", async () => {
    const { w, version } = await inReview("GuardMetadata");
    const id = version.bulletinVersionId;
    for (const update of [
      { $set: { approvedBy: new mongoose.Types.ObjectId(), approvedAt: new Date() } },
      { $set: { approvedByName: "Nobody" } },
      { $set: { returnReason: "Without returning it" } },
      { $set: { reviewedByName: "Nobody" } },
      { $set: { supersededByVersionNo: 9 } },
      { $inc: { revision: 1 } },
      { $push: { history: { eventId: "forged", type: "BULLETIN_VERSION_APPROVED", at: new Date(), versionNo: 1 } } },
    ]) {
      /* Refused whether or not the filter names the state, and whether or not
         a session is offered: without a state change there is no move, and
         without a move there is nothing this record permits. */
      await expect(IeBulletinVersion.findOneAndUpdate({ _id: id }, update))
        .rejects.toThrow(/without moving its state/i);
      await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" }, update))
        .rejects.toThrow(/without moving its state/i);
    }
    const after = await IeBulletinVersion.findById(id).lean();
    expect(after.revision).toBe(1);
    expect(after.approvedBy).toBeNull();
    expect(after.returnReason).toBe("");
    expect(after.history).toHaveLength(1);
    void w;
  });

  test("a legal move still needs a session, one scalar source state and its own fields", async () => {
    const { w, version } = await inReview("GuardMove");
    const id = version.bulletinVersionId;

    /* No session. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" },
      { $set: { state: "RETURNED", returnReason: "No session." } }))
      .rejects.toThrow(/inside a transaction/i);
    /* No source state named. */
    await expect(IeBulletinVersion.updateOne({ _id: id },
      { $set: { state: "RETURNED", returnReason: "No source state." } }))
      .rejects.toThrow(/name the one state it is moving from/i);
    /* A source state, but not a scalar one. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: { $ne: "APPROVED" } },
      { $set: { state: "RETURNED", returnReason: "Not scalar." } }))
      .rejects.toThrow(/name the one state it is moving from/i);
    /* A field belonging to a DIFFERENT transition. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" },
      { $set: { state: "RETURNED", returnReason: "Mixed", approvedByName: "Nobody" } }))
      .rejects.toThrow(/cannot write approvedByName/i);
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" },
      { $set: { state: "APPROVED", approvedAt: new Date(), returnReason: "Mixed" } }))
      .rejects.toThrow(/cannot write returnReason/i);
    /* And a move that does not exist. */
    await expect(IeBulletinVersion.updateOne({ _id: id, state: "RETURNED" },
      { $set: { state: "APPROVED", approvedAt: new Date() } }))
      .rejects.toThrow(/cannot move from RETURNED to APPROVED/i);

    const after = await IeBulletinVersion.findById(id).lean();
    expect(after.state).toBe("IN_REVIEW");
    expect(after.revision).toBe(1);

    /* The service's own return, which satisfies every one of those, works. */
    const ok = await returnVersion(w.approver, w, id, {
      expectedRevision: version.revision, reason: "Through the front door.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version.state).toBe("RETURNED");
  });

  test("the service still supersedes exactly one predecessor, inside the transaction", async () => {
    const { w, version: first } = await approved("SupersedeInTxn");
    let raw = await storedFile(w);
    const second = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    const res = await approveVersion(w.approver, w, second.body.version.bulletinVersionId, {
      expectedRevision: second.body.version.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.supersededVersionNo).toBe(1);

    /* Exactly one predecessor moved, and only the one that was approved. */
    const all = await IeBulletinVersion.find({ ieStyleFileId: w.fileId }).sort({ versionNo: 1 }).lean();
    expect(all.map((v) => v.state)).toEqual(["SUPERSEDED", "APPROVED"]);
    expect(all[0].supersededByVersionNo).toBe(2);
    expect(all[1].supersededByVersionNo).toBeNull();
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId, state: "APPROVED" })).toBe(1);

    /* A third approval supersedes only the second, never the first again. */
    raw = await storedFile(w);
    const third = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    const ok = await approveVersion(w.approver, w, third.body.version.bulletinVersionId, {
      expectedRevision: third.body.version.revision,
    });
    expect(ok.body.supersededVersionNo).toBe(2);
    const again = await IeBulletinVersion.findById(first.bulletinVersionId).lean();
    expect(again.supersededByVersionNo).toBe(2);
    expect(again.history.filter((e) => e.type === "BULLETIN_VERSION_SUPERSEDED")).toHaveLength(1);
  });
});

describe("the file's history events name the revision the file reaches", () => {
  test("a return event carries the returned file's own revision", async () => {
    const { w, version } = await inReview("ReturnRevision");
    const res = await returnVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision, reason: "Needs a re-timed study.",
    });
    expect(res.status).toBe(200);

    const raw = await storedFile(w);
    const event = raw.history.at(-1);
    expect(event.type).toBe("BULLETIN_VERSION_RETURNED");
    expect(event.fileRevision).toBe(res.body.file.revision);
    expect(event.fileRevision).toBe(raw.revision);
    expect(event.fileRevision).toBeGreaterThanOrEqual(1);
  });

  test("an approval event carries the approved file's own revision", async () => {
    const { w, version } = await inReview("ApproveRevision");
    const res = await approveVersion(w.approver, w, version.bulletinVersionId, {
      expectedRevision: version.revision,
    });
    expect(res.status).toBe(200);

    const raw = await storedFile(w);
    const event = raw.history.at(-1);
    expect(event.type).toBe("BULLETIN_VERSION_APPROVED");
    expect(event.fileRevision).toBe(res.body.file.revision);
    expect(event.fileRevision).toBe(raw.revision);
    expect(event.fileRevision).toBeGreaterThanOrEqual(1);
  });

  test("both stay correct when the file already sits at a higher revision", async () => {
    /* Several edits first, so a zero, a one or an off-by-one would all show. */
    const { w, file } = await submittable("HigherRevision");
    let revision = file.revision;
    for (let i = 0; i < 4; i += 1) {
      const edited = await patchBulletin(w.maker, w, w.fileId, {
        expectedRevision: revision,
        rows: file.bulletin.rows.map((r) => ({
          rowId: r.rowId, ieOperationId: r.ieOperationId,
          proposedSamMinutes: i + 2, note: `Pass ${i}`,
        })),
      });
      expect(edited.status).toBe(200);
      revision = edited.body.file.revision;
    }
    expect(revision).toBeGreaterThan(4);

    /* Submit, return, submit again, approve — four more file revisions. */
    const one = await submit(w.maker, w, w.fileId, { expectedRevision: revision });
    expect(one.status).toBe(201);
    const ret = await returnVersion(w.approver, w, one.body.version.bulletinVersionId, {
      expectedRevision: one.body.version.revision, reason: "Once more.",
    });
    expect(ret.status).toBe(200);
    const two = await submit(w.maker, w, w.fileId, { expectedRevision: ret.body.file.revision });
    const app = await approveVersion(w.approver, w, two.body.version.bulletinVersionId, {
      expectedRevision: two.body.version.revision,
    });
    expect(app.status).toBe(200);

    const raw = await storedFile(w);
    const byType = (t) => raw.history.filter((e) => e.type === t);
    expect(byType("BULLETIN_VERSION_RETURNED")[0].fileRevision).toBe(ret.body.file.revision);
    expect(byType("BULLETIN_VERSION_APPROVED")[0].fileRevision).toBe(app.body.file.revision);

    /* Every event on the file, of every type, names a real revision — and the
       revisions only ever climb. */
    const revisions = raw.history.map((e) => e.fileRevision);
    expect(revisions.every((r) => Number.isInteger(r) && r >= 1)).toBe(true);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(revisions.at(-1)).toBe(raw.revision);

    /* And the schema itself would refuse a zero, which is what the old events
       were writing past `$push`. */
    const bad = new IeStyleFile({
      companyId: w.co._id, sampleStyleId: w.style._id, source: { technicalRevision: 1 },
      history: [{ eventId: "x", type: "BULLETIN_VERSION_APPROVED", at: new Date(), fileRevision: 0 }],
    });
    await expect(bad.validate()).rejects.toThrow(/fileRevision/);
  });
});

describe("the allowance policy behind the approved times is an identity pair", () => {
  /** Force every bound study's frozen policy to the given id and revision. */
  async function stampPolicies(w, stamps) {
    const studies = await IeMethodStudy.find({ companyId: w.co._id, status: "APPROVED" })
      .sort({ _id: 1 }).lean();
    expect(studies.length).toBeGreaterThanOrEqual(stamps.length);
    for (let i = 0; i < studies.length; i += 1) {
      const stamp = stamps[Math.min(i, stamps.length - 1)];
      await IeMethodStudy.collection.updateOne({ _id: studies[i]._id }, {
        $set: {
          "allowancePolicy.policyId": stamp.id,
          "allowancePolicy.policyRevision": stamp.revision,
        },
      });
    }
  }

  test("one id at one revision is published as that pair", async () => {
    const { w, file } = await submittable("PolicyAgree");
    const id = new mongoose.Types.ObjectId();
    await stampPolicies(w, [{ id, revision: 3 }]);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(201);
    expect(res.body.version.allowancePolicyId).toBe(String(id));
    expect(res.body.version.allowancePolicyRevision).toBe(3);
  });

  test("one id at two revisions is not an identity, and publishes null", async () => {
    /* Two revisions of one policy are two different sets of percentages. Naming
       the id alone would send a reader to the right record and the wrong
       numbers. */
    const { w, file } = await submittable("PolicyRevisions");
    const id = new mongoose.Types.ObjectId();
    await stampPolicies(w, [{ id, revision: 3 }, { id, revision: 4 }]);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(201);
    expect(res.body.version.allowancePolicyId).toBeNull();
    expect(res.body.version.allowancePolicyRevision).toBeNull();
  });

  test("two different policies publish null", async () => {
    const { w, file } = await submittable("PolicyIds");
    await stampPolicies(w, [
      { id: new mongoose.Types.ObjectId(), revision: 3 },
      { id: new mongoose.Types.ObjectId(), revision: 3 },
    ]);

    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(201);
    expect(res.body.version.allowancePolicyId).toBeNull();
    expect(res.body.version.allowancePolicyRevision).toBeNull();
  });

  test("a policy named without a revision is half an identity, and publishes null", async () => {
    const { w, file } = await submittable("PolicyHalf");
    await stampPolicies(w, [{ id: new mongoose.Types.ObjectId(), revision: null }]);
    const res = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(res.status).toBe(201);
    expect(res.body.version.allowancePolicyId).toBeNull();
    expect(res.body.version.allowancePolicyRevision).toBeNull();
  });
});

describe("the supersession event belongs to the version it is about", () => {
  test("approving version 2 marks version 1, and the event says so", async () => {
    const { w, version: one } = await approved("SupersedeEvent");
    expect(one.versionNo).toBe(1);

    const raw = await storedFile(w);
    const submitted = await submit(w.maker, w, w.fileId, { expectedRevision: raw.revision });
    expect(submitted.body.version.versionNo).toBe(2);
    const res = await approveVersion(w.approver, w, submitted.body.version.bulletinVersionId, {
      expectedRevision: submitted.body.version.revision,
    });
    expect(res.status).toBe(200);

    /* Version 1: superseded, and its own event names ITSELF. */
    const older = await IeBulletinVersion.findById(one.bulletinVersionId).lean();
    expect(older.state).toBe("SUPERSEDED");
    expect(older.supersededByVersionNo).toBe(2);
    const event = older.history.at(-1);
    expect(event.type).toBe("BULLETIN_VERSION_SUPERSEDED");
    expect(event.versionNo).toBe(1);
    expect(event.summary).toContain("version 2");
    /* Every event on this version is about this version. */
    expect(older.history.every((e) => e.versionNo === 1)).toBe(true);

    /* Version 2: approved, and its events are about version 2. */
    const newer = await IeBulletinVersion.findById(submitted.body.version.bulletinVersionId).lean();
    expect(newer.state).toBe("APPROVED");
    expect(newer.supersededByVersionNo).toBeNull();
    expect(newer.supersedesVersionNo).toBe(1);
    expect(newer.history.every((e) => e.versionNo === 2)).toBe(true);

    /* And the file points at version 2. */
    const after = await storedFile(w);
    expect(String(after.currentApprovedBulletinVersionId))
      .toBe(submitted.body.version.bulletinVersionId);
    expect(after.currentApprovedVersionNo).toBe(2);
  });
});

/* ══ 12. A SESSION IS NOT A TRANSACTION ═══════════════════════════════════ */

describe("a transition needs a live transaction, not merely a session", () => {
  test("a formally legal move on a session outside a transaction is refused", async () => {
    const { w, version } = await inReview("SessionNotTransaction");
    const id = version.bulletinVersionId;
    const before = await IeBulletinVersion.findById(id).lean();
    const fileBefore = await storedFile(w);

    /* A real session, deliberately never put into a transaction. Its writes
       would commit one at a time, so the version would move and the Style
       File's review pointer would stay exactly where it is. */
    const session = await mongoose.startSession();
    expect(session.inTransaction()).toBe(false);
    try {
      /* Formally legal in every other respect: a scalar source state, a real
         move, and only that move's own fields. */
      const legalUpdate = {
        $set: {
          state: "RETURNED",
          reviewedBy: new mongoose.Types.ObjectId(),
          reviewedByName: "Outside a transaction",
          reviewedAt: new Date(),
          returnReason: "Written straight to the collection.",
        },
        $inc: { revision: 1 },
      };
      await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" }, legalUpdate, { session }))
        .rejects.toMatchObject({ code: "IE_BULLETIN_VERSION_IMMUTABLE" });
      await expect(IeBulletinVersion.findOneAndUpdate({ _id: id, state: "IN_REVIEW" }, legalUpdate, { session }))
        .rejects.toThrow(/session that is not in one/i);

      /* The same write is still refused for the approval and supersession
         moves, so the rule is about the transaction and not about one verb. */
      await expect(IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" },
        { $set: { state: "APPROVED", approvedAt: new Date() } }, { session }))
        .rejects.toThrow(/session that is not in one/i);
    } finally {
      await session.endSession();
    }

    /* Neither state, revision nor history moved. */
    const after = await IeBulletinVersion.findById(id).lean();
    expect(after.state).toBe("IN_REVIEW");
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.reviewedBy).toBeNull();
    expect(after.returnReason).toBe("");

    /* And the Style File is untouched, still frozen by this very version —
       which is the divergence the rule exists to prevent. */
    const fileAfter = await storedFile(w);
    expect(fileAfter.revision).toBe(fileBefore.revision);
    expect(String(fileAfter.bulletinReviewVersionId)).toBe(id);

    /* ── THE SAME MOVE, THROUGH THE REAL SERVICE, SUCCEEDS ───────────────
       Both records move together: the version becomes RETURNED and the file
       releases its freeze in the same transaction. */
    const res = await returnVersion(w.approver, w, id, {
      expectedRevision: version.revision, reason: "Through the front door.",
    });
    expect(res.status).toBe(200);
    expect(res.body.version.state).toBe("RETURNED");
    expect(res.body.version.revision).toBe(2);
    expect(res.body.file.bulletinReviewVersionId).toBeNull();

    const moved = await IeBulletinVersion.findById(id).lean();
    expect(moved.state).toBe("RETURNED");
    expect(moved.history).toHaveLength(before.history.length + 1);
    const releasedFile = await storedFile(w);
    expect("bulletinReviewVersionId" in releasedFile).toBe(false);
    expect(releasedFile.revision).toBe(fileBefore.revision + 1);
  });

  test("a session inside a transaction is accepted, and its rollback takes the move with it", async () => {
    /* The positive half, so the rule cannot be satisfied by refusing
       everything: the very same update is accepted once the session is
       genuinely in a transaction. Aborting then proves the two facts move as
       one — the version's state and the file's pointer are both unchanged. */
    const { w, version } = await inReview("LiveTransaction");
    const id = version.bulletinVersionId;

    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      expect(session.inTransaction()).toBe(true);
      const res = await IeBulletinVersion.updateOne({ _id: id, state: "IN_REVIEW" }, {
        $set: {
          state: "RETURNED",
          reviewedBy: new mongoose.Types.ObjectId(),
          reviewedByName: "Inside a transaction",
          reviewedAt: new Date(),
          returnReason: "Accepted, then abandoned.",
        },
        $inc: { revision: 1 },
      }, { session });
      expect(res.modifiedCount).toBe(1);
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    const after = await IeBulletinVersion.findById(id).lean();
    expect(after.state).toBe("IN_REVIEW");
    expect(after.revision).toBe(1);
    const raw = await storedFile(w);
    expect(String(raw.bulletinReviewVersionId)).toBe(id);
  });

  test("all four service commands still work through their real transactions", async () => {
    /* Submit, return, submit again, approve, and the supersession a second
       approval performs — every write this chunk makes, end to end. */
    const { w, file } = await submittable("StillWorks");

    const one = await submit(w.maker, w, w.fileId, { expectedRevision: file.revision });
    expect(one.status).toBe(201);
    expect(one.body.version.state).toBe("IN_REVIEW");

    const ret = await returnVersion(w.approver, w, one.body.version.bulletinVersionId, {
      expectedRevision: one.body.version.revision, reason: "Once round again.",
    });
    expect(ret.status).toBe(200);
    expect(ret.body.version.state).toBe("RETURNED");

    const two = await submit(w.maker, w, w.fileId, { expectedRevision: ret.body.file.revision });
    const app = await approveVersion(w.approver, w, two.body.version.bulletinVersionId, {
      expectedRevision: two.body.version.revision,
    });
    expect(app.status).toBe(200);
    expect(app.body.version.state).toBe("APPROVED");
    expect(app.body.file.currentApprovedVersionNo).toBe(2);

    /* And the predecessor supersession, which is the third kind of move. */
    const three = await submit(w.maker, w, w.fileId, { expectedRevision: app.body.file.revision });
    const last = await approveVersion(w.approver, w, three.body.version.bulletinVersionId, {
      expectedRevision: three.body.version.revision,
    });
    expect(last.status).toBe(200);
    expect(last.body.supersededVersionNo).toBe(2);

    const all = await IeBulletinVersion.find({ ieStyleFileId: w.fileId }).sort({ versionNo: 1 }).lean();
    expect(all.map((v) => v.state)).toEqual(["RETURNED", "SUPERSEDED", "APPROVED"]);
    const superseded = all[1];
    expect(superseded.supersededByVersionNo).toBe(3);
    expect(superseded.history.at(-1).versionNo).toBe(2);
  });
});
