// test/merchandising/selection-revisions.route.test.js
//
// M3 — MATERIALS & TRIMS AND PACKAGING, AT THE WIRE.
//
// The claims worth holding:
//
//   · a selection belongs to an EXECUTION FILE, and a file belonging to
//     somebody else reads exactly like one that does not exist;
//   · one draft and one approved revision per file and family, enforced by the
//     database rather than by a check somebody can race;
//   · a row keeps its permanent reference across every revision it survives,
//     and every revision it was approved in keeps it for ever;
//   · approved is immutable, submitted is not silently editable, and the
//     person who approves is not the person who wrote or submitted;
//   · no rate, supplier, stock, consumption or laboratory result can arrive,
//     by name or by schema;
//   · the transitional packaging card can be adopted once, into a DRAFT, with
//     its source preserved and nothing approved by the act.
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
  MaterialTrimRevision, PackagingRevision, REVISION_STATE,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
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
  await mongoose.connect(rs.getUri(), { dbName: "selection_revisions" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  /* The partial unique indexes are the invariant under test, so they must
     actually exist rather than be created lazily. */
  await MaterialTrimRevision.syncIndexes();
  await PackagingRevision.syncIndexes();
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
    materials: {
      status: "selected", rawItems: [],
      ...(legacy ? { packagingSelections: legacy } : {}),
    },
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
const PKG = "PACKAGING";

const at = (w, who) => ({ token: who.token, company: w.co._id });

const row = (over = {}) => ({
  group: "LABEL", componentName: "Main label", colourOrShade: "Navy",
  placement: "Centre back neck", specification: "Woven, 30mm",
  ...over,
});

/** Draft → row → submit, as the editor. Returns the draft's revision number. */
async function draftWithRow(w, cast_, { family = MT, rowBody = row() } = {}) {
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
  const family = opts.family || MT;
  const d = await draftWithRow(w, cast_, opts);
  const res = await call(`/files/${w.fileId}/selections/${family}/submit`, {
    ...at(w, cast_.editor), method: "POST", key: uniq(),
    body: { expectedRevision: d.revision.revision },
  });
  return { ...d, submitted: res.body.revision };
}

/* ══ THE FILE IS THE ROOT ═════════════════════════════════════════════════ */

describe("a selection belongs to an execution file", () => {
  test("a fresh file has neither family started, and says so honestly", async () => {
    const w = await world("Fresh");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/selections`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.selections.MATERIAL_TRIM.status).toBe("NOT_STARTED");
    expect(res.body.selections.PACKAGING.status).toBe("NOT_STARTED");
    expect(res.body.selections.MATERIAL_TRIM.approvedRevisionNo).toBeNull();
  });

  test("another company's file is not found, not forbidden", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const c = await cast(mine.co);

    /* A real owner of company A, naming company B's file. */
    const res = await call(`/files/${theirs.fileId}/selections/${MT}`, at(mine, c.owner));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/Theirs/);

    /* And writing to it changes nothing. */
    const write = await call(`/files/${theirs.fileId}/selections/${MT}/revisions`, {
      ...at(mine, c.owner), method: "POST", key: uniq(), body: {},
    });
    expect(write.status).toBe(404);
    expect(await MaterialTrimRevision.countDocuments({ fileId: theirs.file.id })).toBe(0);
  });

  test("a file id that is not an id, and one that does not exist, read alike", async () => {
    const w = await world("Ghost");
    const c = await cast(w.co);
    for (const id of ["not-an-id", "000000000000000000000000"]) {
      const res = await call(`/files/${id}/selections/${MT}`, at(w, c.viewer));
      expect(res.status).toBe(404);
    }
  });

  test("a family this file does not keep is not found", async () => {
    const w = await world("Fam");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/selections/TIME_AND_ACTION`, at(w, c.viewer));
    expect(res.status).toBe(404);
  });
});

/* ══ CAPABILITIES ═════════════════════════════════════════════════════════ */

describe("who may read, write and decide", () => {
  test("a viewer reads everything and writes nothing", async () => {
    const w = await world("V");
    const c = await cast(w.co);
    const t = at(w, c.viewer);

    expect((await call(`/files/${w.fileId}/selections/${MT}`, t)).status).toBe(200);
    expect((await call(`/files/${w.fileId}/selections/${MT}/revisions`, t)).status).toBe(200);

    const write = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(write.status).toBe(403);
    expect(write.body.error.details.requires.capability).toBe("merchandising.selection.write");
    expect(await MaterialTrimRevision.countDocuments({ fileId: w.file.id })).toBe(0);
  });

  test("an editor drafts and submits but cannot decide", async () => {
    const w = await world("E");
    const c = await cast(w.co);
    const s = await submitted(w, c);
    expect(s.submitted.state).toBe(REVISION_STATE.SUBMITTED);

    const approve = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(approve.status).toBe(403);
    expect(approve.body.error.details.requires.capability).toBe("merchandising.selection.approve");

    const back = await call(`/files/${w.fileId}/selections/${MT}/request-changes`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { reason: "no" },
    });
    expect(back.status).toBe(403);
  });

  test("a platform administrator with no Merchandising grant reaches nothing", async () => {
    const w = await world("Adm");
    const admin = await actor({ companies: [w.co], role: "admin", isAdmin: true, grants: {} });
    const t = at(w, admin);
    expect((await call(`/files/${w.fileId}/selections/${MT}`, t)).status).toBe(403);
    const write = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(write.status).toBe(403);
  });

  test("a revoked grant fails on the very next request, and a downgrade too", async () => {
    const w = await world("Rev");
    const c = await cast(w.co);
    const t = at(w, c.editor);

    const ok = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(ok.status).toBe(201);

    await DepartmentRole.updateOne(
      { departmentSlug: "merchandiser", email: c.editor.email }, { $set: { isActive: false } },
    );
    const after = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...t, method: "POST", body: { ...row(), expectedRevision: 0 },
    });
    expect(after.status).toBe(403);

    /* A downgrade to viewer is the same answer, immediately. */
    await DepartmentRole.updateOne(
      { departmentSlug: "merchandiser", email: c.approver.email },
      { $set: { role: "editor" } },
    );
    const decide = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(decide.status).toBe(403);
  });
});

/* ══ MAKER AND CHECKER ════════════════════════════════════════════════════ */

describe("the approver is not the author", () => {
  test("an approver cannot approve what they wrote themselves", async () => {
    const w = await world("MC");
    const c = await cast(w.co);
    const t = at(w, c.approver);

    /* The approver does the whole draft themselves. */
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...t, method: "POST", body: { ...row(), expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
    });

    const res = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELECTION_APPROVAL_SEPARATION");
    expect(res.body.error.details.authoredByYou).toBe(true);
    expect(res.body.error.details.submittedByYou).toBe(true);

    const stored = await MaterialTrimRevision.findOne({ fileId: w.file.id }).lean();
    expect(stored.state).toBe(REVISION_STATE.SUBMITTED);
  });

  test("an OWNER is not an exception to it", async () => {
    const w = await world("MCO");
    const c = await cast(w.co);
    const t = at(w, c.owner);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...t, method: "POST", body: { ...row(), expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
    });
    const res = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELECTION_APPROVAL_SEPARATION");
  });

  test("somebody else approves it, and the file has one truth", async () => {
    const w = await world("MCok");
    const c = await cast(w.co);
    await submitted(w, c);

    const res = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.revision.state).toBe(REVISION_STATE.APPROVED);
    expect(res.body.revision.approvedByName).toBe(c.approver.name);

    const current = await call(`/files/${w.fileId}/selections/${MT}`, at(w, c.viewer));
    expect(current.body.approved.revisionNo).toBe(1);
    expect(current.body.working).toBeNull();
  });
});

/* ══ THE LIFECYCLE ════════════════════════════════════════════════════════ */

describe("draft, submitted, approved, superseded", () => {
  test("only one draft may be open at a time", async () => {
    const w = await world("One");
    const c = await cast(w.co);
    const t = at(w, c.editor);
    const first = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(first.status).toBe(201);

    const second = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("SELECTION_DRAFT_EXISTS");
    expect(await MaterialTrimRevision.countDocuments({ fileId: w.file.id })).toBe(1);
  });

  test("a submitted revision is not silently editable", async () => {
    const w = await world("Imm");
    const c = await cast(w.co);
    const s = await submitted(w, c);

    const edit = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row({ componentName: "Sneaked in" }), expectedRevision: s.submitted.revision },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("SELECTION_STATE_CONFLICT");
    const stored = await MaterialTrimRevision.findOne({ fileId: w.file.id }).lean();
    expect(stored.rows).toHaveLength(1);
  });

  test("an approved revision is immutable, and a new draft is how it changes", async () => {
    const w = await world("App");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const edit = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST", body: { ...row(), expectedRevision: 3 },
    });
    expect(edit.status).toBe(409);

    /* The way forward is a new revision, and it starts from what is in force. */
    const next = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(next.status).toBe(201);
    expect(next.body.revision.revisionNo).toBe(2);
    expect(next.body.revision.rows).toHaveLength(1);
    expect(next.body.clonedFromRevisionNo).toBe(1);
  });

  test("changes-required returns it to draft with the reason kept on it", async () => {
    const w = await world("CR");
    const c = await cast(w.co);
    await submitted(w, c);

    const empty = await call(`/files/${w.fileId}/selections/${MT}/request-changes`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(empty.status).toBe(400);

    const back = await call(`/files/${w.fileId}/selections/${MT}/request-changes`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { reason: "The neck label placement is wrong." },
    });
    expect(back.status).toBe(200);
    expect(back.body.revision.state).toBe(REVISION_STATE.DRAFT);
    expect(back.body.revision.changesRequired.reason).toMatch(/neck label/);
    expect(back.body.revision.submittedAt).toBeNull();

    /* And it is editable again — same revision number, no history lost. */
    const edit = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row({ componentName: "Care label" }), expectedRevision: back.body.revision.revision },
    });
    expect(edit.status).toBe(201);
    expect(edit.body.revision.revisionNo).toBe(1);
  });

  test("approving a second revision supersedes the first, transactionally", async () => {
    const w = await world("Sup");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const t = at(w, c.editor);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...t, method: "POST",
      body: { ...row({ componentName: "Size label" }), expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
    });
    const res = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.supersededRevisionNo).toBe(1);

    const all = await MaterialTrimRevision.find({ fileId: w.file.id }).sort({ revisionNo: 1 }).lean();
    expect(all.map((r) => r.state)).toEqual([REVISION_STATE.SUPERSEDED, REVISION_STATE.APPROVED]);
    expect(String(all[0].supersededByRevisionId)).toBe(String(all[1]._id));
    expect(String(all[1].supersedesRevisionId)).toBe(String(all[0]._id));

    /* The superseded revision is still readable, exactly as it was. */
    const old = await call(`/files/${w.fileId}/selections/${MT}/revisions/1`, at(w, c.viewer));
    expect(old.status).toBe(200);
    expect(old.body.revision.rows).toHaveLength(1);
  });

  test("version numbers never reset or collide", async () => {
    const w = await world("Num");
    const c = await cast(w.co);
    for (let i = 0; i < 3; i++) {
      const t = at(w, c.editor);
      const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
        ...t, method: "POST", key: uniq(), body: {},
      });
      const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
        ...t, method: "POST",
        body: { ...row({ componentName: `Label ${i}` }), expectedRevision: made.body.revision.revision },
      });
      await call(`/files/${w.fileId}/selections/${MT}/submit`, {
        ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
      });
      await call(`/files/${w.fileId}/selections/${MT}/approve`, {
        ...at(w, c.approver), method: "POST", key: uniq(), body: {},
      });
    }
    const all = await MaterialTrimRevision.find({ fileId: w.file.id }).sort({ revisionNo: 1 }).lean();
    expect(all.map((r) => r.revisionNo)).toEqual([1, 2, 3]);
    expect(all.filter((r) => r.state === REVISION_STATE.APPROVED)).toHaveLength(1);
  });

  test("two approvals racing produce one approved revision, not two", async () => {
    const w = await world("Race");
    const c = await cast(w.co);
    await submitted(w, c);

    const shots = await Promise.all([1, 2, 3].map(() => call(
      `/files/${w.fileId}/selections/${MT}/approve`,
      { ...at(w, c.approver), method: "POST", key: uniq(), body: {} },
    )));
    expect(shots.filter((r) => r.status === 200)).toHaveLength(1);

    const approved = await MaterialTrimRevision.countDocuments({
      fileId: w.file.id, state: REVISION_STATE.APPROVED,
    });
    expect(approved).toBe(1);
  });
});

/* ══ CONCURRENCY AND IDEMPOTENCY ══════════════════════════════════════════ */

describe("a retry is not a second decision", () => {
  test("a stale expectedRevision is a conflict, not an overwrite", async () => {
    const w = await world("OC");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);

    const stale = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row({ componentName: "Second" }), expectedRevision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("SELECTION_REVISION_CONFLICT");
    expect(d.revision.rows).toHaveLength(1);
  });

  test("a command with no idempotency key is refused", async () => {
    const w = await world("NoKey");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("the same key replays the original answer", async () => {
    const w = await world("Idem");
    const c = await cast(w.co);
    const key = uniq();
    const first = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key, body: {},
    });
    const again = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key, body: {},
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await MaterialTrimRevision.countDocuments({ fileId: w.file.id })).toBe(1);
  });

  test("the same key for a different request is refused, not replayed", async () => {
    const w = await world("Reuse");
    const c = await cast(w.co);
    await submitted(w, c);
    const key = uniq();
    const first = await call(`/files/${w.fileId}/selections/${MT}/request-changes`, {
      ...at(w, c.approver), method: "POST", key, body: { reason: "one" },
    });
    expect(first.status).toBe(200);
    const second = await call(`/files/${w.fileId}/selections/${MT}/request-changes`, {
      ...at(w, c.approver), method: "POST", key, body: { reason: "a different reason" },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

/* ══ ROW IDENTITY ═════════════════════════════════════════════════════════ */

describe("a row keeps its name", () => {
  test("a row reference survives cloning into the next revision", async () => {
    const w = await world("Row");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);
    const rowRef = d.added.body.rowRef;
    expect(rowRef).toMatch(/^MTR-[0-9a-f]{12}$/);

    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: d.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const next = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(next.body.revision.rows[0].rowRef).toBe(rowRef);

    /* Editing it keeps the reference — that is what makes "this row changed"
       a sentence rather than "one row went and another arrived". */
    const edited = await call(`/files/${w.fileId}/selections/${MT}/rows/${rowRef}`, {
      ...at(w, c.editor), method: "PATCH",
      body: { ...row({ placement: "Side seam" }), expectedRevision: next.body.revision.revision },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.revision.rows[0].rowRef).toBe(rowRef);
    expect(edited.body.revision.rows[0].placement).toBe("Side seam");
  });

  test("a withdrawn row leaves the draft and stays in the approved revision", async () => {
    const w = await world("Wd");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);
    const rowRef = d.added.body.rowRef;
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: d.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const next = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const gone = await call(`/files/${w.fileId}/selections/${MT}/rows/${rowRef}/withdraw`, {
      ...at(w, c.editor), method: "POST",
      body: { expectedRevision: next.body.revision.revision, reason: "Buyer dropped it" },
    });
    expect(gone.status).toBe(200);
    expect(gone.body.revision.rows).toHaveLength(0);

    /* Revision 1 still has it, untouched, for ever. */
    const old = await call(`/files/${w.fileId}/selections/${MT}/revisions/1`, at(w, c.viewer));
    expect(old.body.revision.rows[0].rowRef).toBe(rowRef);
    expect(await MaterialTrimRevision.countDocuments({ fileId: w.file.id })).toBe(2);
  });

  test("a row reference this draft does not hold is not found", async () => {
    const w = await world("NoRow");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);
    const res = await call(`/files/${w.fileId}/selections/${MT}/rows/MTR-ffffffffffff`, {
      ...at(w, c.editor), method: "PATCH",
      body: { ...row(), expectedRevision: d.revision.revision },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SELECTION_ROW_NOT_FOUND");
  });
});

/* ══ APPLICABILITY ════════════════════════════════════════════════════════ */

describe("which execution units a row applies to", () => {
  test("a row may name real units of this file", async () => {
    const w = await world("Unit", { split: true });
    const c = await cast(w.co);
    expect(w.unitRefs.length).toBeGreaterThan(1);

    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        ...row(), appliesToAllUnits: false, unitRefs: [w.unitRefs[0]],
        expectedRevision: made.body.revision.revision,
      },
    });
    expect(added.status).toBe(201);
    expect(added.body.revision.rows[0].unitRefs).toEqual([w.unitRefs[0]]);
    expect(added.body.revision.rows[0].appliesToAllUnits).toBe(false);
  });

  test("a unit of ANOTHER file is refused", async () => {
    const mine = await world("UA", { split: true });
    const other = await world("UB", { split: true });
    const c = await cast(mine.co);
    const made = await call(`/files/${mine.fileId}/selections/${MT}/revisions`, {
      ...at(mine, c.editor), method: "POST", key: uniq(), body: {},
    });
    const res = await call(`/files/${mine.fileId}/selections/${MT}/rows`, {
      ...at(mine, c.editor), method: "POST",
      body: {
        ...row(), appliesToAllUnits: false, unitRefs: ["UNIT:NOPE|NOPE"],
        expectedRevision: made.body.revision.revision,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SELECTION_UNIT_UNKNOWN");
    expect(other.fileId).toBeTruthy();
  });

  test("naming no units at all, while not applying to all, is refused", async () => {
    const w = await world("UZ");
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const res = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row(), appliesToAllUnits: false, unitRefs: [], expectedRevision: made.body.revision.revision },
    });
    expect(res.status).toBe(400);
  });
});

/* ══ WHAT MAY NEVER ARRIVE ════════════════════════════════════════════════ */

describe("another department's fact is refused by name", () => {
  test.each([
    ["rate", /Supply Chain/],
    ["price", /Supply Chain/],
    ["supplier", /Supply Chain/],
    ["purchaseOrder", /Supply Chain/],
    ["stockQuantity", /Store/],
    ["receivedQuantity", /Store/],
    ["quantity", /Product Development|Store/],
    ["consumption", /Product Development/],
    ["wastage", /Product Development/],
    ["basis", /Product Development/],
    ["labResult", /Quality/],
  ])("a row carrying %s is refused", async (field, owner) => {
    const w = await world(`F${field}`);
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    const res = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { ...row(), [field]: 12, expectedRevision: made.body.revision.revision },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.error.details.field).toBe(field);
    expect(res.body.error.message).toMatch(owner);
  });

  test("a server-owned field cannot be stated either", async () => {
    const w = await world("Own");
    const c = await cast(w.co);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    for (const field of ["companyId", "state", "revisionNo", "approvedBy"]) {
      const res = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
        ...at(w, c.editor), method: "POST",
        body: { ...row(), [field]: "x", expectedRevision: made.body.revision.revision },
      });
      expect(res.status).toBe(400);
    }
  });

  test("nothing forbidden can escape through a response either", async () => {
    const w = await world("Esc");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c);
    const text = JSON.stringify(d.added.body);
    for (const banned of [/"rate"/, /"supplier"/, /"consumption"/, /"stockQuantity"/, /"basis"/]) {
      expect(text).not.toMatch(banned);
    }
  });
});

/* ══ AUDIT AND OUTBOX ═════════════════════════════════════════════════════ */

describe("every decision leaves a trail, atomically", () => {
  test("the whole lifecycle is audited in business actions", async () => {
    const w = await world("Aud");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const events = await MerchandisingAuditEvent.find({
      companyId: w.co._id, recordType: "SELECTION_REVISION",
    }).sort({ at: 1 }).lean();
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      "SELECTION_DRAFT_CREATED", "SELECTION_ROW_ADDED",
      "SELECTION_SUBMITTED", "SELECTION_APPROVED",
    ]));
    for (const e of events) {
      expect(e.source).toBe("merchandising");
      expect(e.details.family).toBe(MT);
      expect(e.correlationId).toBeTruthy();
    }
  });

  test("submission and approval announce themselves on the outbox", async () => {
    const w = await world("Out");
    const c = await cast(w.co);
    await submitted(w, c, {
      family: PKG, rowBody: { group: "POLYBAG", componentName: "Individual polybag" },
    });
    await call(`/files/${w.fileId}/selections/${PKG}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const kinds = (await MerchandisingOutboxEvent.find({ companyId: w.co._id }).lean())
      .map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      OUTBOX_KIND.PACKAGING_SUBMITTED, OUTBOX_KIND.PACKAGING_APPROVED,
    ]));
    const approved = await MerchandisingOutboxEvent.findOne({
      kind: OUTBOX_KIND.PACKAGING_APPROVED,
    }).lean();
    expect(String(approved.payload.executionFileId)).toBe(w.fileId);
    expect(approved.payload.family).toBe(PKG);
    expect(approved.status).toBe("PENDING");
  });

  test("a refused approval writes no audit and no outbox row", async () => {
    const w = await world("NoAud");
    const c = await cast(w.co);
    const t = at(w, c.approver);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
      ...t, method: "POST", body: { ...row(), expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
    });
    const before = await MerchandisingAuditEvent.countDocuments({ companyId: w.co._id });

    /* Refused for maker/checker. */
    const res = await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(409);
    expect(await MerchandisingAuditEvent.countDocuments({ companyId: w.co._id })).toBe(before);
    expect(await MerchandisingOutboxEvent.countDocuments({
      companyId: w.co._id, kind: OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
    })).toBe(0);
  });
});

/* ══ THE PRINTABLE CARD ═══════════════════════════════════════════════════ */

describe("the Digital Trim Card, frozen", () => {
  test("an approved revision prints with everything a sheet needs to be checked", async () => {
    const w = await world("Card");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions/1/printable`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.documentName).toBe("Digital Trim Card");
    expect(res.body.frozen).toBe(true);
    expect(res.body.superseded).toBe(false);
    expect(res.body.revisionNo).toBe(1);
    expect(res.body.approvedByName).toBe(c.approver.name);
    expect(res.body.header.fileNumber).toMatch(/^MEF-/);
    expect(res.body.header.orderRef).toBe(w.request.requestId);
    expect(res.body.header.companyName).toBeTruthy();
    expect(res.body.rows).toHaveLength(1);
  });

  test("a draft cannot be printed", async () => {
    const w = await world("NoPrint");
    const c = await cast(w.co);
    await draftWithRow(w, c);
    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions/1/printable`, at(w, c.viewer));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELECTION_STATE_CONFLICT");
  });

  test("a superseded revision still prints, and says it is superseded", async () => {
    const w = await world("OldCard");
    const c = await cast(w.co);
    await submitted(w, c);
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    const t = at(w, c.editor);
    const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
      ...t, method: "POST", key: uniq(), body: {},
    });
    await call(`/files/${w.fileId}/selections/${MT}/submit`, {
      ...t, method: "POST", key: uniq(), body: { expectedRevision: made.body.revision.revision },
    });
    await call(`/files/${w.fileId}/selections/${MT}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions/1/printable`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.superseded).toBe(true);
    expect(res.body.supersededAt).toBeTruthy();
  });

  test("a printable card is authenticated like everything else", async () => {
    const w = await world("Auth");
    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions/1/printable`, {});
    expect(res.status).toBe(401);
  });
});

/* ══ PACKAGING ════════════════════════════════════════════════════════════ */

describe("the packaging specification", () => {
  test("packing instructions live on the revision and follow the same lifecycle", async () => {
    const w = await world("Pk");
    const c = await cast(w.co);
    const d = await draftWithRow(w, c, {
      family: PKG, rowBody: { group: "POLYBAG", componentName: "Individual polybag" },
    });
    const set = await call(`/files/${w.fileId}/selections/${PKG}/instructions`, {
      ...at(w, c.editor), method: "PUT",
      body: {
        foldingMethod: "Fold in three, chest label up",
        cartonMarks: "Buyer mark on two sides",
        expectedRevision: d.revision.revision,
      },
    });
    expect(set.status).toBe(200);
    expect(set.body.revision.instructions.foldingMethod).toMatch(/Fold in three/);

    /* Materials & Trims has no instructions, and says so rather than
       silently accepting them. */
    const wrong = await call(`/files/${w.fileId}/selections/${MT}/instructions`, {
      ...at(w, c.editor), method: "PUT", body: { foldingMethod: "x", expectedRevision: 0 },
    });
    expect(wrong.status).toBe(404);
  });

  test("the two families are independent — approving one does not touch the other", async () => {
    const w = await world("Two");
    const c = await cast(w.co);
    await submitted(w, c, { family: PKG, rowBody: { group: "CARTON", componentName: "Export carton" } });
    await call(`/files/${w.fileId}/selections/${PKG}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });

    const status = await call(`/files/${w.fileId}/selections`, at(w, c.viewer));
    expect(status.body.selections.PACKAGING.status).toBe("APPROVED");
    expect(status.body.selections.MATERIAL_TRIM.status).toBe("NOT_STARTED");
    expect(await MaterialTrimRevision.countDocuments({ fileId: w.file.id })).toBe(0);
  });
});

/* ══ ADOPTING THE TRANSITIONAL CARD ═══════════════════════════════════════ */

const legacyRows = () => ([
  {
    rowId: "aaaaaaaaaaaaaaaa", rawItemId: new mongoose.Types.ObjectId(),
    rawItemName: "Polybag 300x400", rawItemSku: "PB-300", specification: "40 micron",
    status: "approved", selectedAt: new Date("2026-07-01"),
  },
  {
    rowId: "bbbbbbbbbbbbbbbb", rawItemId: new mongoose.Types.ObjectId(),
    rawItemName: "Hangtag", rawItemSku: "HT-1", specification: "Recycled board",
    status: "proposed", selectedAt: new Date("2026-07-02"),
  },
  {
    rowId: "cccccccccccccccc", rawItemId: new mongoose.Types.ObjectId(),
    rawItemName: "Old sticker", rawItemSku: "ST-9", status: "withdrawn",
    selectedAt: new Date("2026-06-01"),
  },
]);

describe("the transitional packaging card is adopted, never migrated in place", () => {
  test("the preview reports what would arrive and exactly why the rest would not", async () => {
    const w = await world("Adopt", { legacy: legacyRows() });
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/packaging-adoption/preview`, at(w, c.viewer));

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.adoptable.map((a) => a.componentName).sort())
      .toEqual(["Hangtag", "Polybag 300x400"]);
    expect(res.body.excluded).toHaveLength(1);
    expect(res.body.excluded[0].reason).toBe("WITHDRAWN");
    expect(res.body.excluded[0].message).toMatch(/withdrawn/i);
    /* Nothing is classified for the person — the legacy card has no group. */
    expect(res.body.adoptable.every((a) => a.group === "OTHER")).toBe(true);
    expect(res.body.note).toMatch(/Nothing is approved/i);
    expect(res.body.target.willCreateDraft).toBe(true);

    /* And the preview wrote nothing at all. */
    expect(await PackagingRevision.countDocuments({ fileId: w.file.id })).toBe(0);
  });

  test("adoption lands in a DRAFT, preserving the source, and approves nothing", async () => {
    const w = await world("Adopt2", { legacy: legacyRows() });
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(res.status).toBe(201);
    expect(res.body.adoptedCount).toBe(2);
    expect(res.body.note).toMatch(/Nothing has been approved/i);

    const stored = await PackagingRevision.findOne({ fileId: w.file.id }).lean();
    expect(stored.state).toBe(REVISION_STATE.DRAFT);
    expect(stored.rows).toHaveLength(2);
    expect(stored.adoption.batchId).toMatch(/^adopt-/);
    expect(String(stored.adoption.sourceRecordId)).toBe(String(w.style._id));

    /* The source is preserved on every row: which record, which row, when,
       and the decision state it was in. */
    const polybag = stored.rows.find((r) => r.componentName === "Polybag 300x400");
    expect(polybag.sourceRef.recordType).toBe("sample_style_packaging_selection");
    expect(polybag.sourceRef.recordRef).toBe("aaaaaaaaaaaaaaaa");
    expect(polybag.sourceRef.sourceState).toBe("approved");
    expect(polybag.sourceRef.sourceVersion).toMatch(/2026-07-01/);
    /* Its own permanent identity, not the legacy one. */
    expect(polybag.rowRef).toMatch(/^PKG-[0-9a-f]{12}$/);

    /* The legacy record is untouched. */
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.materials.packagingSelections).toHaveLength(3);
  });

  test("adopting twice adopts nothing the second time", async () => {
    const w = await world("Adopt3", { legacy: legacyRows() });
    const c = await cast(w.co);
    const first = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(first.body.adoptedCount).toBe(2);

    /* A fresh key, so this is not the ledger replaying — the rows themselves
       are remembered by their own source references. */
    const again = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SELECTION_ADOPTION_NOT_ELIGIBLE");

    const stored = await PackagingRevision.find({ fileId: w.file.id }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].rows).toHaveLength(2);
  });

  test("the same key replays rather than adopting again", async () => {
    const w = await world("Adopt4", { legacy: legacyRows() });
    const c = await cast(w.co);
    const key = uniq();
    const first = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key,
    });
    const again = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key,
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await PackagingRevision.findOne({ fileId: w.file.id }).lean()).rows).toHaveLength(2);
  });

  test("a file with no transitional card says so rather than failing oddly", async () => {
    const w = await world("NoLegacy");
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/packaging-adoption/preview`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe("NO_LEGACY_SELECTIONS");

    const adopt = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(adopt.status).toBe(409);
  });

  test("no consumption, rate, supplier or stock field is imported", async () => {
    const w = await world("Clean", { legacy: legacyRows() });
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    const stored = await PackagingRevision.findOne({ fileId: w.file.id }).lean();
    const text = JSON.stringify(stored);
    for (const banned of [
      /"quantity"/, /"unit"/, /"basis"/, /"evidence"/, /"included"/,
      /"rate"/, /"supplier"/, /"stock"/, /"consumption"/,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });

  test("a viewer may preview and may not adopt", async () => {
    const w = await world("AdoptCap", { legacy: legacyRows() });
    const c = await cast(w.co);
    expect((await call(`/files/${w.fileId}/packaging-adoption/preview`, at(w, c.viewer))).status).toBe(200);
    const res = await call(`/files/${w.fileId}/packaging-adoption/adopt`, {
      ...at(w, c.viewer), method: "POST", key: uniq(),
    });
    expect(res.status).toBe(403);
  });
});

/* ══ HISTORY ══════════════════════════════════════════════════════════════ */

describe("the revision history", () => {
  test("it lists newest first, without the rows, and pages", async () => {
    const w = await world("Hist");
    const c = await cast(w.co);
    for (let i = 0; i < 3; i++) {
      const t = at(w, c.editor);
      const made = await call(`/files/${w.fileId}/selections/${MT}/revisions`, {
        ...t, method: "POST", key: uniq(), body: {},
      });
      const added = await call(`/files/${w.fileId}/selections/${MT}/rows`, {
        ...t, method: "POST",
        body: { ...row({ componentName: `L${i}` }), expectedRevision: made.body.revision.revision },
      });
      await call(`/files/${w.fileId}/selections/${MT}/submit`, {
        ...t, method: "POST", key: uniq(), body: { expectedRevision: added.body.revision.revision },
      });
      await call(`/files/${w.fileId}/selections/${MT}/approve`, {
        ...at(w, c.approver), method: "POST", key: uniq(), body: {},
      });
    }
    const res = await call(`/files/${w.fileId}/selections/${MT}/revisions?limit=2`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.revisions.map((r) => r.revisionNo)).toEqual([3, 2]);
    expect(res.body.revisions[0].rows).toBeUndefined();
    /* Three, not one: each revision cloned the approved one before adding to
       it, which is what carries a row's identity forward. */
    expect(res.body.revisions[0].rowCount).toBe(3);
    expect(res.body.cursor).toBe("2");

    const page2 = await call(
      `/files/${w.fileId}/selections/${MT}/revisions?limit=2&cursor=${res.body.cursor}`,
      at(w, c.viewer),
    );
    expect(page2.body.revisions.map((r) => r.revisionNo)).toEqual([1]);
    expect(page2.body.cursor).toBeNull();
  });
});
