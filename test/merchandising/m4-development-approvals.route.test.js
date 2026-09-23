// test/merchandising/selection-revisions.route.test.js
//
// M4 — DEVELOPMENT REQUIREMENTS AND THE APPROVAL REGISTER, AT THE WIRE.
//
// The claims worth holding:
//
//   · development requirements are a third family of the SAME versioned,
//     approved, superseded record — one draft, one approved, stable
//     `requirementRef`, maker/checker, idempotency, all inherited;
//   · the approval register records REQUIREMENTS and never decisions: there is
//     no endpoint, no field and no code path by which Merchandising can
//     complete another department's approval;
//   · a Merchandising-owned approval resolves from Merchandising's own
//     approved revision, live;
//   · an external approval with no producer reads AWAITING_SOURCE_RECORD —
//     which is not a synonym for outstanding and is never a blank;
//   · the transitional development card adopts once, into a DRAFT, carrying no
//     quantity, basis or costing figure.
//
// On a replica set, because every decision commits with its audit and its
// outbox announcement or not at all.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision, REVISION_STATE,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const {
  ApprovalRegister, OBSERVED_STATUS,
} = require("../../models/CMS_Models/Merchandising/ApprovalRegister");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "m4_development" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  /* The partial unique indexes are the invariant under test, so they must
     actually exist rather than be created lazily. */
  await MaterialTrimRevision.syncIndexes();
  await PackagingRevision.syncIndexes();
  await DevelopmentRevision.syncIndexes();
  await ApprovalRegister.syncIndexes();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  });

const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {}, role = "merchandiser", isAdmin = false } = {}) {
  const n = ++seq;
  const email = `m3-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `Three${n}`, email, biometricId: `M3${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    name: `User ${n}`,
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, role, employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

/**
 * A company with an accepted handover, so there is a real Execution File —
 * the only way one exists.
 */
async function world(label = "S", { quantity = 400, split = false, legacy = null } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Acct ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd",
    materials: { status: "selected", rawItems: [] },
    ...(legacy ? { sample: { serviceRequirements: legacy } } : {}),
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: `${label} polo`, totalQuantity: quantity,
      totalEstimatedPrice: 240, sampleStyleId: style._id,
    }],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  const deliveries = split
    ? [
      { dropRef: "D1", committedDeliveryDate: "2026-11-01", quantity: quantity / 2 },
      { dropRef: "D2", committedDeliveryDate: "2026-12-01", quantity: quantity / 2 },
    ]
    : [{ dropRef: "D1", committedDeliveryDate: "2026-11-01", quantity }];

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(request._id), lineId: lineRef,
    body: { expectedCurrentVersionNo: 0, deliveries },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  /* Accept it, which is the only way a file comes to exist. */
  const reviewer = await actor({ companies: [co], grants: { merchandiser: "approver" } });
  const accepted = await execution.acceptHandover(
    { companyId: co._id },
    { id: String(version._id), actor: { name: reviewer.name, email: reviewer.email } },
  );
  const units = await ExecutionUnit.find({ fileId: accepted.file.id }).lean();

  return {
    co, style, request, lineRef, version, label,
    file: accepted.file,
    fileId: String(accepted.file.id),
    unitRefs: units.map((u) => u.unitDiscriminator),
  };
}

/** Editor, approver and a second approver — the cast maker/checker needs. */
async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
  };
}

const MT = "MATERIAL_TRIM";
const DEV = "DEVELOPMENT";

const at = (w, who) => ({ token: who.token, company: w.co._id });

/** A development requirement, as a caller states one. */
const row = (over = {}) => ({
  requirementType: "FIT_SAMPLE",
  title: "Fit sample, size M",
  brief: "One garment in the base colourway for fit approval.",
  requiredByDate: "2026-10-15",
  responsibleApplication: "PRODUCT_DEVELOPMENT",
  ...over,
});

/** Draft → row → submit, as the editor. Returns the draft's revision number. */
async function draftWithRow(w, cast_, { family = DEV, rowBody = row() } = {}) {
  const t = at(w, cast_.editor);
  const made = await call(`/files/${w.fileId}/selections/${family}/revisions`, {
    ...t, method: "POST", key: uniq(), body: {},
  });
  const added = await call(`/files/${w.fileId}/selections/${family}/rows`, {
    ...t, method: "POST",
    body: { ...rowBody, expectedRevision: made.body.revision.revision },
  });
  return { made, added, revision: added.body.revision };
}

async function submitted(w, cast_, opts = {}) {
  const family = opts.family || DEV;
  const d = await draftWithRow(w, cast_, opts);
  const res = await call(`/files/${w.fileId}/selections/${family}/submit`, {
    ...at(w, cast_.editor), method: "POST", key: uniq(),
    body: { expectedRevision: d.revision.revision },
  });
  return { ...d, submitted: res.body.revision };
}


/* ══ DEVELOPMENT REQUIREMENTS — A THIRD FAMILY, NOT A THIRD MACHINE ═══════ */

describe("development requirements inherit the whole selection lifecycle", () => {
  test("a fresh file has no development revision, and says so", async () => {
    const w = await world("D0");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/selections/${DEV}`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Development Requirements");
    expect(res.body.approved).toBeNull();
    expect(res.body.working).toBeNull();
  });

  test("a requirement carries its own stable reference, and its own fields", async () => {
    const w = await world("D1");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);
    expect(d.added.status).toBe(201);

    const [req] = d.revision.rows;
    expect(req.requirementRef).toMatch(/^DEV-[0-9a-f]{12}$/);
    expect(req.requirementType).toBe("FIT_SAMPLE");
    expect(req.title).toBe("Fit sample, size M");
    expect(req.responsibleApplication).toBe("PRODUCT_DEVELOPMENT");
    expect(req.approvedReferenceExpected).toBe(true);
    expect(new Date(req.requiredByDate).getUTCFullYear()).toBe(2026);
  });

  test("every requirement type the plan names is accepted", async () => {
    const w = await world("D2");
    const c = await cast(w.co);
    const t = at(w, c.editor);
    const made = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    let rev = made.body.revision.revision;
    for (const type of [
      "FIT_SAMPLE", "SIZE_SET_SAMPLE", "PRE_PRODUCTION_SAMPLE", "SHIPMENT_SAMPLE",
      "PRINT", "EMBROIDERY", "WASH", "ARTWORK", "MOULD", "SCREEN", "DIE", "OTHER",
    ]) {
      const res = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
        ...t, method: "POST",
        body: { ...row({ requirementType: type, title: `A ${type}` }), expectedRevision: rev },
      });
      expect(res.status).toBe(201);
      rev = res.body.revision.revision;
    }
    expect((await call(`/files/${w.fileId}/selections/${DEV}`, at(w, c.viewer)))
      .body.working.rows).toHaveLength(12);
  });

  test("an invented requirement type is refused", async () => {
    const w = await world("D3");
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const res = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row({ requirementType: "TELEPORTER" }), expectedRevision: made.body.revision.revision },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("requirementType");
  });

  test("the full lifecycle runs, with maker/checker and supersession", async () => {
    const w = await world("D4");
    const c = await cast(w.co);
    await submitted(w, c);

    /* The author cannot approve their own. */
    const self = await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(self.status).toBe(403);          // editor lacks the capability at all

    const ok = await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(ok.status).toBe(200);
    expect(ok.body.revision.state).toBe(REVISION_STATE.APPROVED);

    /* A second revision supersedes the first, keeping the requirement's ref. */
    const ref = ok.body.revision.rows[0].requirementRef;
    const t = at(w, c.editor);
    const next = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(next.body.revision.rows[0].requirementRef).toBe(ref);
    await call(`/files/${w.fileId}/selections/${DEV}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: next.body.revision.revision },
    });
    const second = await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(second.body.supersededRevisionNo).toBe(1);

    const all = await DevelopmentRevision.find({ fileId: w.file.id }).sort({ revisionNo: 1 }).lean();
    expect(all.map((r) => r.state)).toEqual([REVISION_STATE.SUPERSEDED, REVISION_STATE.APPROVED]);
  });

  test("an owner cannot approve a requirement revision they wrote", async () => {
    const w = await world("D5");
    const c = await cast(w.co);
    const t = at(w, c.owner);
    const made = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
      ...t, method: "POST", body: { ...row(), expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${DEV}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
    });
    const res = await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELECTION_APPROVAL_SEPARATION");
  });

  test("no technical execution field can be stated on a requirement", async () => {
    const w = await world("D6");
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    for (const field of [
      "quantity", "basis", "evidence", "consumption", "rate", "supplier",
      "measurements", "labResult",
    ]) {
      const res = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
        ...at(w, c.editor), method: "POST",
        body: { ...row(), [field]: "x", expectedRevision: made.body.revision.revision },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(field);
    }
  });

  test("a requirement may apply to selected execution units only", async () => {
    const w = await world("D7", { split: true });
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${DEV}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const ok = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        ...row(), appliesToAllUnits: false, unitRefs: [w.unitRefs[0]],
        expectedRevision: made.body.revision.revision,
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.revision.rows[0].unitRefs).toEqual([w.unitRefs[0]]);

    const bad = await call(`/files/${w.fileId}/selections/${DEV}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        ...row(), appliesToAllUnits: false, unitRefs: ["UNIT:NOPE|NOPE"],
        expectedRevision: ok.body.revision.revision,
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("SELECTION_UNIT_UNKNOWN");
  });

  test("approval announces itself on the outbox, under its own kind", async () => {
    const w = await world("D8");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const kinds = (await MerchandisingOutboxEvent.find({ companyId: w.co._id }).lean())
      .map((e) => e.kind);
    expect(kinds).toContain("merchandising.development_requirements.submitted");
    expect(kinds).toContain("merchandising.development_requirements.approved");
  });

  test("another company's file is not found", async () => {
    const mine = await world("DA");
    const theirs = await world("DB");
    const c = await cast(mine.co);
    const res = await call(`/files/${theirs.fileId}/selections/${DEV}`, at(mine, c.owner));
    expect(res.status).toBe(404);
  });
});

/* ══ THE APPROVAL REGISTER ════════════════════════════════════════════════ */

const requirement = (over = {}) => ({
  category: "BUYER_SAMPLE_APPROVAL",
  requiredByDate: "2026-10-20",
  note: "Buyer to approve the fit sample before size set.",
  ...over,
});

async function addApproval(w, c, body = requirement(), who = "editor") {
  const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
  return call(`/files/${w.fileId}/approvals`, {
    ...at(w, c[who]), method: "POST",
    body: { ...body, expectedRevision: read.body.revision },
  });
}

describe("the approval register records requirements, never decisions", () => {
  test("a fresh register is empty and offers the categories, with their owners", async () => {
    const w = await world("A0");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    const owners = new Set(res.body.categories.map((x) => x.owningApplication));
    expect(owners).toEqual(new Set(["MERCHANDISING", "SALES", "PRODUCT_DEVELOPMENT", "QUALITY"]));
    /* Merchandising's own are the only ones marked internally owned. */
    const internal = res.body.categories.filter((x) => x.internallyOwned).map((x) => x.code);
    expect(internal.sort()).toEqual(["DEVELOPMENT_SCHEDULE", "MATERIAL_TRIM_CARD", "PACKAGING_SPEC"]);
  });

  test("an approval requirement is added with a stable reference", async () => {
    const w = await world("A1");
    const c = await cast(w.co);
    const res = await addApproval(w, c);
    expect(res.status).toBe(201);
    expect(res.body.approvalRequirementRef).toMatch(/^APR-[0-9a-f]{12}$/);

    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const [r] = read.body.rows;
    expect(r.category).toBe("BUYER_SAMPLE_APPROVAL");
    /* The owner follows the category and is never taken from the body. */
    expect(r.owningApplication).toBe("SALES");
    expect(r.internallyOwned).toBe(false);
  });

  test("the owning application cannot be stated by the caller", async () => {
    const w = await world("A2");
    const c = await cast(w.co);
    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/approvals`, {
      ...at(w, c.editor), method: "POST",
      body: { ...requirement({ owningApplication: "MERCHANDISING" }), expectedRevision: read.body.revision },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("owningApplication");
  });

  /* ── THE HEADLINE ─────────────────────────────────────────────────── */
  test.each([
    ["observation"], ["status"], ["decidedBy"], ["decidedAt"], ["approved"],
    ["approvedBy"], ["result"], ["outcome"], ["testResult"], ["buyerDecision"],
  ])("a caller cannot record a decision through %s", async (field) => {
    const w = await world(`A3${field}`);
    const c = await cast(w.co);
    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/approvals`, {
      ...at(w, c.owner), method: "POST",
      body: { ...requirement(), [field]: "APPROVED", expectedRevision: read.body.revision },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.error.details.field).toBe(field);
    expect(res.body.error.message).toMatch(/cannot record/i);
  });

  test("there is no endpoint that completes an approval", async () => {
    const w = await world("A4");
    const c = await cast(w.co);
    const added = await addApproval(w, c);
    const ref = added.body.approvalRequirementRef;
    for (const [method, path] of [
      ["POST", `/files/${w.fileId}/approvals/${ref}/approve`],
      ["POST", `/files/${w.fileId}/approvals/${ref}/complete`],
      ["POST", `/files/${w.fileId}/approvals/${ref}/decision`],
      ["PUT", `/files/${w.fileId}/approvals/${ref}/status`],
    ]) {
      const res = await call(path, { ...at(w, c.owner), method, body: { status: "APPROVED" } });
      expect(res.status).toBe(404);
    }
    const still = await call(`/files/${w.fileId}/approvals/${ref}`, at(w, c.viewer));
    expect(still.body.row.status).toBe(OBSERVED_STATUS.AWAITING_SOURCE_RECORD);
  });

  test("editing a requirement leaves the observation untouched", async () => {
    const w = await world("A5");
    const c = await cast(w.co);
    const added = await addApproval(w, c);
    const ref = added.body.approvalRequirementRef;
    const before = await call(`/files/${w.fileId}/approvals/${ref}`, at(w, c.viewer));

    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/approvals/${ref}`, {
      ...at(w, c.editor), method: "PATCH",
      body: { ...requirement({ note: "Changed my mind about the date." }), expectedRevision: read.body.revision },
    });
    expect(res.status).toBe(200);
    const after = await call(`/files/${w.fileId}/approvals/${ref}`, at(w, c.viewer));
    expect(after.body.row.note).toMatch(/Changed my mind/);
    expect(after.body.row.status).toBe(before.body.row.status);
    expect(after.body.row.approvalRequirementRef).toBe(ref);
  });
});

/* ══ EXTERNAL DECISIONS ═══════════════════════════════════════════════════ */

describe("an external decision with no producer says so", () => {
  test.each([
    ["BUYER_STYLE_APPROVAL", "SALES", "Sales"],
    ["TECH_PACK_RELEASED", "PRODUCT_DEVELOPMENT", "Product Development"],
    ["FINAL_INSPECTION_CLEARED", "QUALITY", "Quality"],
  ])("%s reads AWAITING_SOURCE_RECORD and names %s", async (category, owner, label) => {
    const w = await world(`E${category}`);
    const c = await cast(w.co);
    await addApproval(w, c, requirement({ category }));
    const res = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const [r] = res.body.rows;
    expect(r.owningApplication).toBe(owner);
    expect(r.status).toBe(OBSERVED_STATUS.AWAITING_SOURCE_RECORD);
    /* Not "outstanding", not blank, and it says whose record is missing. */
    expect(r.reason).toMatch(new RegExp(label));
    expect(r.reason).toMatch(/does not yet publish a record/i);
    expect(r.decidedAt).toBeNull();
  });

  test("observing changes nothing while no source exists, and takes no status", async () => {
    const w = await world("E1");
    const c = await cast(w.co);
    await addApproval(w, c, requirement({ category: "BUYER_LAB_DIP" }));

    /* A caller trying to smuggle a decision through the observe door. */
    const res = await call(`/files/${w.fileId}/approvals/observe`, {
      ...at(w, c.owner), method: "POST", body: { status: "APPROVED", decidedByName: "Nobody" },
    });
    expect(res.status).toBe(200);

    const after = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(after.body.rows[0].status).toBe(OBSERVED_STATUS.AWAITING_SOURCE_RECORD);
    expect(after.body.rows[0].decidedByName).toBe("");
    /* It did record WHEN it looked, which is the point of observing. */
    expect(after.body.rows[0].observedAt).toBeTruthy();
  });

  test("the summary counts awaiting-source apart from outstanding", async () => {
    const w = await world("E2");
    const c = await cast(w.co);
    await addApproval(w, c, requirement({ category: "BUYER_STYLE_APPROVAL" }));
    await addApproval(w, c, requirement({ category: "MATERIAL_TRIM_CARD" }));

    const res = await call(`/files/${w.fileId}/approvals/summary`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.awaitingSource).toBe(1);
    expect(res.body.counts.approved).toBe(0);
    /* The Merchandising one is genuinely outstanding — nobody has drafted it. */
    expect(res.body.counts.outstanding).toBe(1);
  });
});

/* ══ MERCHANDISING'S OWN APPROVALS RESOLVE LIVE ═══════════════════════════ */

describe("an internal approval reads from Merchandising's own record", () => {
  test("it moves with the revision, and nobody types it", async () => {
    const w = await world("I1");
    const c = await cast(w.co);
    await addApproval(w, c, requirement({ category: "DEVELOPMENT_SCHEDULE" }));

    const empty = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(empty.body.rows[0].status).toBe(OBSERVED_STATUS.NOT_STARTED);
    expect(empty.body.rows[0].internallyOwned).toBe(true);

    await submitted(w, c);
    const waiting = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(waiting.body.rows[0].status).toBe(OBSERVED_STATUS.IN_PROGRESS);

    await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const done = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(done.body.rows[0].status).toBe(OBSERVED_STATUS.APPROVED);
    expect(done.body.rows[0].decidedByName).toBe(c.approver.name);
    expect(done.body.rows[0].observedSourceVersion).toBe("revision 1");

    /* And it is not stored — the register holds no copy to go stale. */
    const stored = await ApprovalRegister.findOne({ fileId: w.file.id }).lean();
    expect(stored.rows[0].observation.status).toBe(OBSERVED_STATUS.NOT_STARTED);
  });

  test("a trim-card approval resolves from the trim card, not from development", async () => {
    const w = await world("I2");
    const c = await cast(w.co);
    await addApproval(w, c, requirement({ category: "MATERIAL_TRIM_CARD" }));
    await submitted(w, c, { family: DEV });
    await call(`/files/${w.fileId}/selections/${DEV}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const res = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    /* The development family being approved says nothing about the trim card. */
    expect(res.body.rows[0].status).toBe(OBSERVED_STATUS.NOT_STARTED);
  });
});

/* ══ CAPABILITIES AND CONCURRENCY ON THE REGISTER ═════════════════════════ */

describe("who may change the register", () => {
  test("a viewer reads it and adds nothing", async () => {
    const w = await world("C1");
    const c = await cast(w.co);
    expect((await call(`/files/${w.fileId}/approvals`, at(w, c.viewer))).status).toBe(200);
    const res = await addApproval(w, c, requirement(), "viewer");
    expect(res.status).toBe(403);
    expect(res.body.error.details.requires.capability).toBe("merchandising.selection.write");
  });

  test("a platform administrator with no Merchandising grant reaches nothing", async () => {
    const w = await world("C2");
    const admin = await actor({ companies: [w.co], role: "admin", isAdmin: true, grants: {} });
    expect((await call(`/files/${w.fileId}/approvals`, at(w, admin))).status).toBe(403);
  });

  test("a revoked grant fails on the very next request", async () => {
    const w = await world("C3");
    const c = await cast(w.co);
    expect((await addApproval(w, c)).status).toBe(201);
    await DepartmentRole.updateOne(
      { departmentSlug: "merchandiser", email: c.editor.email }, { $set: { isActive: false } },
    );
    const res = await addApproval(w, c);
    expect(res.status).toBe(403);
  });

  test("a stale expectedRevision is a conflict, not an overwrite", async () => {
    const w = await world("C4");
    const c = await cast(w.co);
    await addApproval(w, c);
    const res = await call(`/files/${w.fileId}/approvals`, {
      ...at(w, c.editor), method: "POST",
      body: { ...requirement({ category: "BUYER_LAB_DIP" }), expectedRevision: 0 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELECTION_REVISION_CONFLICT");
    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    expect(read.body.rows).toHaveLength(1);
  });

  test("another company's register is not found, and nothing is written", async () => {
    const mine = await world("C5");
    const theirs = await world("C6");
    const c = await cast(mine.co);
    const res = await call(`/files/${theirs.fileId}/approvals`, {
      ...at(mine, c.owner), method: "POST", body: { ...requirement(), expectedRevision: 0 },
    });
    expect(res.status).toBe(404);
    expect(await ApprovalRegister.countDocuments({ fileId: theirs.file.id })).toBe(0);
  });

  test("a unit of another file cannot be named in an approval's applicability", async () => {
    const w = await world("C7", { split: true });
    const c = await cast(w.co);
    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/approvals`, {
      ...at(w, c.editor), method: "POST",
      body: {
        ...requirement(), appliesToAllUnits: false, unitRefs: ["UNIT:NOPE|NOPE"],
        expectedRevision: read.body.revision,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SELECTION_UNIT_UNKNOWN");
  });
});

/* ══ AUDIT ════════════════════════════════════════════════════════════════ */

describe("the register's own history", () => {
  test("creating and changing a requirement is audited; a reading is not an event unless it changed", async () => {
    const w = await world("AU");
    const c = await cast(w.co);
    const added = await addApproval(w, c);
    const ref = added.body.approvalRequirementRef;
    const read = await call(`/files/${w.fileId}/approvals`, at(w, c.viewer));
    await call(`/files/${w.fileId}/approvals/${ref}`, {
      ...at(w, c.editor), method: "PATCH",
      body: { ...requirement({ note: "New note" }), expectedRevision: read.body.revision },
    });

    const events = await MerchandisingAuditEvent.find({
      companyId: w.co._id, recordType: "APPROVAL_REGISTER",
    }).sort({ at: 1 }).lean();
    expect(events.map((e) => e.action)).toEqual([
      "APPROVAL_REQUIREMENT_CREATED", "APPROVAL_REQUIREMENT_UPDATED",
    ]);
    expect(events[0].details.owningApplication).toBe("SALES");

    /* Observing found the same answer, so nothing was added to the history. */
    await call(`/files/${w.fileId}/approvals/observe`, { ...at(w, c.editor), method: "POST", body: {} });
    const after = await MerchandisingAuditEvent.countDocuments({
      companyId: w.co._id, recordType: "APPROVAL_REGISTER",
    });
    expect(after).toBe(2);
  });
});

/* ══ THE TRANSITIONAL DEVELOPMENT CARD ════════════════════════════════════ */

const legacyDev = () => ([
  {
    rowId: "dev0000000000001", purpose: "DEVELOPMENT_TOOLING",
    serviceName: "Screen making", developmentChargeKey: "screen-making",
    specification: "Four screens, body and sleeve", quantity: 4,
    billingUnit: "screen", basis: "FIXED_PER_RUN", owner: "RND",
    included: true, notes: "Artwork from the buyer",
  },
  {
    rowId: "dev0000000000002", purpose: "DEVELOPMENT_TOOLING",
    serviceName: "Pattern development", developmentChargeKey: "pattern-development",
    quantity: 1, included: false, excludedReason: "Existing pattern reused",
  },
  {
    rowId: "dev0000000000003", purpose: "OUTSIDE_PROCESS",
    serviceName: "Garment wash", quantity: 500, included: true,
  },
]);

describe("the transitional development card is adopted, never migrated", () => {
  test("the preview reports what would arrive and why the rest would not", async () => {
    const w = await world("L1", { legacy: legacyDev() });
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/development-adoption/preview`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.adoptable.map((a) => a.title)).toEqual(["Screen making"]);
    const reasons = res.body.excluded.map((e) => e.reason).sort();
    expect(reasons).toEqual(["EXCLUDED_AT_SOURCE", "NOT_DEVELOPMENT"]);
    expect(res.body.note).toMatch(/No quantity, basis or costing figure is copied/i);
    /* Read-only: nothing was written. */
    expect(await DevelopmentRevision.countDocuments({ fileId: w.file.id })).toBe(0);
  });

  test("adoption lands in a draft, preserves the source and copies no costing figure", async () => {
    const w = await world("L2", { legacy: legacyDev() });
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(res.status).toBe(201);
    expect(res.body.adoptedCount).toBe(1);

    const stored = await DevelopmentRevision.findOne({ fileId: w.file.id }).lean();
    expect(stored.state).toBe(REVISION_STATE.DRAFT);
    const [req] = stored.rows;
    expect(req.title).toBe("Screen making");
    expect(req.requirementType).toBe("OTHER");        // never guessed from a charge key
    expect(req.requirementCode).toBe("screen-making");
    expect(req.sourceRef.recordRef).toBe("dev0000000000001");
    expect(req.sourceRef.recordType).toBe("sample_style_service_requirement");
    expect(req.rowRef).toMatch(/^DEV-[0-9a-f]{12}$/);

    /* Not one costing or consumption FIELD crossed. Matched as a key, so
       the preserved source state — which legitimately records that the
       source row was INCLUDED — is not mistaken for the legacy flag. */
    const text = JSON.stringify(stored);
    for (const field of ["quantity", "billingUnit", "basis", "owner", "evidence", "included", "excludedReason"]) {
      expect(text).not.toMatch(new RegExp(`"${field}":`));
    }
    /* The source's decision IS preserved, as a state on the reference. */
    expect(req.sourceRef.sourceState).toBe("INCLUDED");

    /* And the legacy record is untouched. */
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.sample.serviceRequirements).toHaveLength(3);
  });

  test("adopting twice adopts nothing the second time", async () => {
    const w = await world("L3", { legacy: legacyDev() });
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    const again = await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SELECTION_ADOPTION_NOT_ELIGIBLE");
    expect((await DevelopmentRevision.findOne({ fileId: w.file.id }).lean()).rows).toHaveLength(1);
  });

  test("the same key replays rather than adopting again", async () => {
    const w = await world("L4", { legacy: legacyDev() });
    const c = await cast(w.co);
    const key = uniq();
    const first = await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key,
    });
    const again = await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key,
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });

  test("a viewer may preview and may not adopt", async () => {
    const w = await world("L5", { legacy: legacyDev() });
    const c = await cast(w.co);
    expect((await call(`/files/${w.fileId}/development-adoption/preview`, at(w, c.viewer))).status).toBe(200);
    const res = await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.viewer), method: "POST", key: uniq(),
    });
    expect(res.status).toBe(403);
  });

  test("nothing is approved by adopting", async () => {
    const w = await world("L6", { legacy: legacyDev() });
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/development-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    const cur = await call(`/files/${w.fileId}/selections/${DEV}`, at(w, c.viewer));
    expect(cur.body.approved).toBeNull();
    expect(cur.body.working.state).toBe(REVISION_STATE.DRAFT);
  });
});
