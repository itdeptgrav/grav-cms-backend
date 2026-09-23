// test/merchandising/execution-file.route.test.js
//
// MERCHANDISING RECEIVES, DECIDES AND COORDINATES — at the wire.
//
// The whole receiver: the inbox, accept and clarify, the one-file invariant,
// the Execution Units, assignment, the lifecycle matrix, history, cursor
// pagination and the Overview's count/list parity. On a replica set, because
// every decision commits with its receipt, its file, its units, its audit
// trail and its outbox entry — or not at all.
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
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "execution_file" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body } = {}) =>
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
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: r.status, body };
  });

async function actor({ companies = [], grants = {}, isAdmin = false, tokenRole = "employee" } = {}) {
  const n = ++seq;
  const email = `xf${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "X", lastName: `F${n}`, email, biometricId: `XF${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `Person ${n}` });
  }
  const rows = {};
  for (const [departmentSlug, role] of Object.entries(grants)) {
    rows[departmentSlug] = await DepartmentRole.create({
      departmentSlug, email, name: `Person ${n}`, role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email, grantRows: rows,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Person ${n}`, role: tokenRole, employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company with a confirmed order line, issued as a handover by Sales. */
async function world(label = "X", { quantity = 500 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
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
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`,
    status: "quotation_sales_approved",
    orderOrigin: "customer",
    customerInfo: { name: `Buying Office ${n}` },
    items: [{ stockItemName: `${label} polo`, totalQuantity: quantity, sampleStyleId: style._id }],
  });
  /* The line's own permanent reference, minted by the CustomerRequest hook
     as the record was written — not the style, which one order may carry on
     two commercial lines. */
  const saved = await CustomerRequest.findById(request._id).lean();
  return { co, style, request, lineId: String(saved.items[0].lineRef), quantity, label };
}

/**
 * Sales issues, through the real producer service — and the announcement is
 * then carried to Merchandising's receiver, exactly as the Sales route does
 * after its transaction commits. Calling only the producer would leave the
 * event pending, which is a state worth testing on purpose (see the ownership
 * suite) but is not what "Sales issued this" means.
 */
async function issued(w, body = {}) {
  const { version, correlationId } = await producer.issue({ companyId: w.co._id }, {
    requestId: String(w.request._id),
    lineId: w.lineId,
    body: {
      expectedCurrentVersionNo: body.expectedCurrentVersionNo ?? 0,
      deliveries: body.deliveries || [{ committedDeliveryDate: "2026-12-15", quantity: w.quantity }],
      ...(body.breakdown ? { breakdown: body.breakdown } : {}),
      ...(body.packingRequirement ? { packingRequirement: body.packingRequirement } : {}),
    },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: w.co._id, correlationId });
  return version;
}

/** A company, its approver, and one issued version — the common start. */
async function ready(label = "R") {
  const w = await world(label);
  const version = await issued(w);
  const approver = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
  const t = { token: approver.token, company: w.co._id };
  return { ...w, version, approver, t };
}

const accept = (w, id, t) => call(`/handovers/${id}/accept`, { ...t, method: "POST", body: {} });
const clarify = (w, id, t, body) => call(`/handovers/${id}/clarify`, { ...t, method: "POST", body });

/* ══ THE INBOX ════════════════════════════════════════════════════════════ */

describe("the inbox", () => {
  test("lists the current version with the allowlisted row, receipt PENDING", async () => {
    const w = await ready("In");
    const res = await call("/handovers", w.t);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.rowType).toBe("HANDOVER");
    expect(row.orderRef).toBe(w.request.requestId);
    expect(row.styleRef).toBe(w.style.styleCode);
    expect(row.totalQuantity).toBe(500);
    expect(row.versionNo).toBe(1);
    expect(row.receiptState).toBe("PENDING");
    expect(row.buyerDisplayLabel).toMatch(/Buying Office/);
    /* No commercial or CRM fact in any row. */
    const raw = JSON.stringify(res.body);
    for (const banned of [/price/i, /payment/i, /margin/i, /quotation/i, /journeyId/, /accountId/, /email/i, /phone/i]) {
      expect(raw).not.toMatch(banned);
    }
  });

  test("foreign and missing handovers are indistinguishable", async () => {
    const mine = await ready("Fm");
    const theirs = await ready("Ft");
    const gone = new mongoose.Types.ObjectId();

    const foreign = await call(`/handovers/${theirs.version._id}`, mine.t);
    const missing = await call(`/handovers/${gone}`, mine.t);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.message).toBe(missing.body.error.message);

    /* And the inbox holds only mine. */
    const inbox = await call("/handovers", mine.t);
    expect(inbox.body.rows.map((r) => r.orderRef)).toEqual([mine.request.requestId]);
  });

  test("there is no decline route", async () => {
    const w = await ready("Nd");
    const res = await call(`/handovers/${w.version._id}/decline`, { ...w.t, method: "POST", body: {} });
    expect(res.status).toBe(404);
  });
});

/* ══ ACCEPTANCE ═══════════════════════════════════════════════════════════ */

describe("acceptance", () => {
  test("opens exactly one file, with receipt, units, audit and outbox — atomically", async () => {
    const w = await ready("Ac");
    const res = await accept(w, w.version._id, w.t);
    expect(res.status).toBe(201);
    const file = res.body.file;
    expect(file.fileNumber).toMatch(/^MEF-\d{4}-\d{4}$/);
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.totalQuantity).toBe(500);
    expect(file.sourceVersionHistory).toHaveLength(1);

    expect(await ExecutionFile.countDocuments({})).toBe(1);
    expect(await ExecutionUnit.countDocuments({})).toBe(1);
    const unit = await ExecutionUnit.findOne({}).lean();
    expect(unit.unitDiscriminator).toBe("DEFAULT");
    expect(unit.quantity).toBe(500);
    expect(unit.sourceVersionNo).toBe(1);

    const receipt = await HandoverReceipt.findOne({}).lean();
    expect(receipt.state).toBe("ACCEPTED");
    expect(String(receipt.executionFileId)).toBe(file.id);

    const outbox = await MerchandisingOutboxEvent.findOne({ kind: "HANDOVER_ACCEPTED" }).lean();
    expect(outbox.status).toBe("PENDING");
    expect(outbox.correlationId).toBe(receipt.correlationId);

    const actions = (await MerchandisingAuditEvent.find({}).lean()).map((e) => e.action).sort();
    expect(actions).toEqual(expect.arrayContaining(["FILE_CREATED", "HANDOVER_ACCEPTED", "HANDOVER_ISSUED"]));
  });

  test("is idempotent — retrying returns the same file, and writes nothing new", async () => {
    const w = await ready("Id");
    const first = await accept(w, w.version._id, w.t);
    const again = await accept(w, w.version._id, w.t);
    expect(again.status).toBe(200);
    expect(again.body.alreadyAccepted).toBe(true);
    expect(again.body.file.id).toBe(first.body.file.id);
    expect(await ExecutionFile.countDocuments({})).toBe(1);
    expect(await HandoverReceipt.countDocuments({})).toBe(1);
    expect(await MerchandisingOutboxEvent.countDocuments({})).toBe(1);
  });

  test("concurrent acceptance creates one file", async () => {
    const w = await ready("Cc");
    const results = await Promise.all([
      accept(w, w.version._id, w.t),
      accept(w, w.version._id, w.t),
      accept(w, w.version._id, w.t),
    ]);
    for (const r of results) expect([200, 201]).toContain(r.status);
    const ids = new Set(results.map((r) => r.body.file.id));
    expect(ids.size).toBe(1);
    expect(await ExecutionFile.countDocuments({})).toBe(1);
    expect(await HandoverReceipt.countDocuments({})).toBe(1);
  });

  test("only the latest issued version is acceptable; accepting v2 updates the same file", async () => {
    const w = await ready("Sv");
    /* Sales corrects itself before Merchandising decides: v2 supersedes an
       UNACCEPTED v1. */
    const v2 = await issued(w, {
      expectedCurrentVersionNo: 1,
      deliveries: [{ committedDeliveryDate: "2027-02-01", quantity: 500 }],
    });

    /* The old statement was never accepted, and now never can be. */
    const stale = await accept(w, w.version._id, w.t);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("HANDOVER_STATE_CONFLICT");
    expect(await ExecutionFile.countDocuments({})).toBe(0);

    /* Accept v2 → file. Then v3 issues; accepting it lands on the SAME file. */
    const res2 = await accept(w, v2._id, w.t);
    expect(res2.status).toBe(201);
    const fileId = res2.body.file.id;

    const v3 = await issued(w, {
      expectedCurrentVersionNo: 2,
      deliveries: [{ committedDeliveryDate: "2027-03-01", quantity: 500 }],
    });
    const res3 = await accept(w, v3._id, w.t);
    expect(res3.status).toBe(201);
    expect(res3.body.file.id).toBe(fileId);
    expect(res3.body.file.sourceVersionHistory).toHaveLength(2);
    expect(await ExecutionFile.countDocuments({})).toBe(1);

    /* Retrying the ACCEPTED-then-superseded v2 is idempotent — it returns the
       file it opened, and changes nothing. That is a retry, not a decision. */
    const retry = await accept(w, v2._id, w.t);
    expect(retry.status).toBe(200);
    expect(retry.body.alreadyAccepted).toBe(true);
    expect(retry.body.file.id).toBe(fileId);

    const detail = await call(`/files/${fileId}`, w.t);
    expect(new Date(detail.body.file.deliveries[0].committedDeliveryDate).toISOString())
      .toContain("2027-03-01");
  });

  test("a cancelled version has nothing to accept", async () => {
    const w = await ready("Cx");
    await producer.cancel({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineId,
      reason: "Buyer withdrew.", actor: { name: "Sales" },
    });
    const res = await accept(w, w.version._id, w.t);
    expect(res.status).toBe(409);
    expect(await ExecutionFile.countDocuments({})).toBe(0);
  });

  test("there is no public POST /files", async () => {
    const w = await ready("Pf");
    const res = await call("/files", { ...w.t, method: "POST", body: { fileNumber: "MEF-9999-0001" } });
    expect(res.status).toBe(404);
    expect(await ExecutionFile.countDocuments({})).toBe(0);
  });
});

/* ══ CLARIFICATION ════════════════════════════════════════════════════════ */

describe("clarification", () => {
  test("requires a category and text, creates no file, and reaches the outbox", async () => {
    const w = await ready("Cl");

    const noCat = await clarify(w, w.version._id, w.t, { reason: "What packing?" });
    expect(noCat.status).toBe(400);
    const noText = await clarify(w, w.version._id, w.t, { category: "OTHER" });
    expect(noText.status).toBe(400);
    expect(noText.body.error.details.field).toBe("reason");

    const res = await clarify(w, w.version._id, w.t, {
      category: "PACKING_TESTING_REQUIREMENT_UNCLEAR",
      reason: "The polybag spec names two thicknesses.",
    });
    expect(res.status).toBe(201);
    expect(await ExecutionFile.countDocuments({})).toBe(0);

    const receipt = await HandoverReceipt.findOne({}).lean();
    expect(receipt.state).toBe("CLARIFICATION_REQUESTED");
    expect(receipt.clarification.category).toBe("PACKING_TESTING_REQUIREMENT_UNCLEAR");
    expect(await MerchandisingOutboxEvent.countDocuments({ kind: "CLARIFICATION_REQUESTED" })).toBe(1);

    /* The inbox now shows the state, and a second request is a conflict. */
    const inbox = await call("/handovers", w.t);
    expect(inbox.body.rows[0].receiptState).toBe("CLARIFICATION_REQUESTED");
    const twice = await clarify(w, w.version._id, w.t, { category: "OTHER", reason: "again" });
    expect(twice.status).toBe(409);
  });

  test("a factory-capability mismatch is a clarification, and Sales resolves it with v2", async () => {
    const w = await ready("Fc");
    await clarify(w, w.version._id, w.t, {
      category: "FACTORY_CAPABILITY_MISMATCH",
      reason: "Nominated factory has no seam-sealing line.",
    });
    /* Sales answers with a corrected version; the old clarification reads as
       settled by supersession, and the new version is decidable. */
    const v2 = await issued(w, { expectedCurrentVersionNo: 1 });
    const detail = await call(`/handovers/${v2._id}`, w.t);
    const v1row = detail.body.lineage.find((l) => l.versionNo === 1);
    expect(v1row.receiptState).toBe("SUPERSEDED");
    expect((await accept(w, v2._id, w.t)).status).toBe(201);
  });

  test("acceptance after a clarification on the SAME current version is allowed", async () => {
    /* Sales answered outside the record (a call, a meeting); the version is
       still the latest statement and the merchandiser may now accept it. */
    const w = await ready("Ca");
    await clarify(w, w.version._id, w.t, { category: "OTHER", reason: "Which brand label?" });
    const res = await accept(w, w.version._id, w.t);
    expect(res.status).toBe(201);
    const receipt = await HandoverReceipt.findOne({}).lean();
    expect(receipt.state).toBe("ACCEPTED");
  });
});

/* ══ EXECUTION UNITS ══════════════════════════════════════════════════════ */

describe("execution units", () => {
  test("splits become one unit per confirmed tuple, reconciling to the total", async () => {
    const w = await world("Un", { quantity: 600 });
    const version = await issued(w, {
      breakdown: [
        { attributes: [{ name: "Colour", value: "Navy" }], sizeRange: "S-XL", quantity: 400 },
        { attributes: [{ name: "Colour", value: "White" }], sizeRange: "S-XL", quantity: 200 },
      ],
      deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: 600, nominatedFactoryRef: "F1" }],
    });
    const approver = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: approver.token, company: w.co._id };
    const res = await accept(w, version._id, t);
    expect(res.status).toBe(201);

    const units = await ExecutionUnit.find({}).sort({ unitDiscriminator: 1 }).lean();
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.quantity).reduce((a, b) => a + b, 0)).toBe(600);
    expect(units[0].attributes[0].value).toMatch(/Navy|White/);
    /* Each split inherits the single drop's date and factory. */
    for (const u of units) {
      expect(u.dropRef).toBe("DROP-1");
      expect(u.nominatedFactoryRef).toBe("F1");
    }
  });

  test("a later version adds units without changing the file's identity", async () => {
    const w = await ready("U2");
    const first = await accept(w, w.version._id, w.t);
    const fileId = first.body.file.id;

    const v2 = await issued(w, {
      expectedCurrentVersionNo: 1,
      deliveries: [
        { dropRef: "DROP-1", committedDeliveryDate: "2026-12-15", quantity: 300 },
        { dropRef: "DROP-2", committedDeliveryDate: "2027-01-20", quantity: 200 },
      ],
    });
    await accept(w, v2._id, w.t);

    const units = await ExecutionUnit.find({ active: true }).lean();
    expect(units).toHaveLength(2);
    for (const u of units) expect(u.sourceVersionNo).toBe(2);
    /* The DEFAULT unit of v1 is withdrawn, not erased. */
    const withdrawn = await ExecutionUnit.findOne({ active: false }).lean();
    expect(withdrawn.unitDiscriminator).toBe("DEFAULT");
    expect(String(withdrawn.fileId)).toBe(fileId);
  });

  test("units cannot be added through any public endpoint", async () => {
    const w = await ready("U3");
    const first = await accept(w, w.version._id, w.t);
    for (const path of [`/files/${first.body.file.id}/units`, "/units"]) {
      const res = await call(path, { ...w.t, method: "POST", body: { quantity: 1 } });
      expect(res.status).toBe(404);
    }
  });
});

/* ══ ASSIGNMENT ═══════════════════════════════════════════════════════════ */

describe("assignment", () => {
  async function withFile(label = "As") {
    const w = await ready(label);
    const owner = await actor({ companies: [w.co], grants: { merchandiser: "owner" } });
    const file = (await accept(w, w.version._id, w.t)).body.file;
    return { ...w, owner, file, to: { token: owner.token, company: w.co._id } };
  }

  test("only file.assign may assign; the assignee must be a live member here", async () => {
    const w = await withFile();
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });

    /* An approver holds lifecycle but not assign. */
    const denied = await call(`/files/${w.file.id}/assignments`, {
      ...w.t, method: "POST", body: { email: merch.email, expectedRevision: w.file.revision },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.requires.capability).toBe("merchandising.file.assign");

    /* A stranger with no grant cannot be assigned. */
    const stranger = await actor({ companies: [w.co] });
    const badAssignee = await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST", body: { email: stranger.email, expectedRevision: w.file.revision },
    });
    expect(badAssignee.status).toBe(400);

    /* A live merchandiser in this company can be. */
    const ok = await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST", body: { email: merch.email, expectedRevision: w.file.revision },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.file.responsibleMerchandiser.email).toBe(merch.email);
  });

  test("reassignment needs a reason; history is kept; assignment grants nothing", async () => {
    const w = await withFile("As2");
    const a = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    const b = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });

    const first = await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST", body: { email: a.email, expectedRevision: w.file.revision },
    });
    expect(first.status).toBe(201);

    const noReason = await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST", body: { email: b.email, expectedRevision: first.body.file.revision },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.field).toBe("reason");

    const second = await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST",
      body: { email: b.email, reason: "A is on leave.", expectedRevision: first.body.file.revision },
    });
    expect(second.status).toBe(201);

    const stored = await ExecutionFile.findById(w.file.id).lean();
    expect(stored.assignmentHistory).toHaveLength(2);

    /* The RESPONSIBLE viewer still cannot mutate anything: assignment is a
       record attribute, never authority. */
    const mutate = await call(`/files/${w.file.id}/lifecycle/hold`, {
      token: b.token, company: w.co._id, method: "POST",
      body: { reason: "x", expectedRevision: second.body.file.revision },
    });
    expect(mutate.status).toBe(403);
  });

  test("the register filters by responsible merchandiser", async () => {
    const w = await withFile("As3");
    const a = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    await call(`/files/${w.file.id}/assignments`, {
      ...w.to, method: "POST", body: { email: a.email, expectedRevision: w.file.revision },
    });
    const mineList = await call(`/files?view=active&assignedTo=${encodeURIComponent(a.email)}`, w.t);
    expect(mineList.body.rows).toHaveLength(1);
    const nobody = await call("/files?view=active&assignedTo=nobody@grav.test", w.t);
    expect(nobody.body.rows).toEqual([]);
  });
});

/* ══ LIFECYCLE ════════════════════════════════════════════════════════════ */

describe("the lifecycle matrix", () => {
  async function withFile(label) {
    const w = await ready(label);
    const file = (await accept(w, w.version._id, w.t)).body.file;
    return { ...w, file };
  }
  const move = (w, cmd, body) => call(`/files/${w.file.id}/lifecycle/${cmd}`, { ...w.t, method: "POST", body });

  test("hold needs a reason; hold → resume → close → reopen all audit", async () => {
    const w = await withFile("Lc");

    const bare = await move(w, "hold", { expectedRevision: w.file.revision });
    expect(bare.status).toBe(400);

    const held = await move(w, "hold", { reason: "Buyer reviewing artwork.", expectedRevision: w.file.revision });
    expect(held.status).toBe(200);
    expect(held.body.file.lifecycleStatus).toBe("ON_HOLD");

    /* No close from hold — resume first. */
    const closeFromHold = await move(w, "close", { expectedRevision: held.body.file.revision });
    expect(closeFromHold.status).toBe(409);

    const resumed = await move(w, "resume", { expectedRevision: held.body.file.revision });
    expect(resumed.body.file.lifecycleStatus).toBe("OPEN");

    const closed = await move(w, "close", { expectedRevision: resumed.body.file.revision });
    expect(closed.body.file.lifecycleStatus).toBe("CLOSED");

    const reopenBare = await move(w, "reopen", { expectedRevision: closed.body.file.revision });
    expect(reopenBare.status).toBe(400);
    const reopened = await move(w, "reopen", { reason: "Buyer revived the order.", expectedRevision: closed.body.file.revision });
    expect(reopened.body.file.lifecycleStatus).toBe("OPEN");

    const actions = (await MerchandisingAuditEvent.find({ recordType: "EXECUTION_FILE" }).lean())
      .map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["FILE_HELD", "FILE_RESUMED", "FILE_CLOSED", "FILE_REOPENED"]));
  });

  test("a stale revision is a conflict, not an overwrite", async () => {
    const w = await withFile("Lr");
    await move(w, "hold", { reason: "r1", expectedRevision: w.file.revision });
    const stale = await move(w, "resume", { expectedRevision: w.file.revision });   // old revision
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("FILE_REVISION_CONFLICT");
  });

  test("there is no Merchandising cancel, and Sales' cancellation is mirrored and final", async () => {
    const w = await withFile("Lx");
    const cancel = await call(`/files/${w.file.id}/cancel`, { ...w.t, method: "POST", body: { reason: "x" } });
    expect(cancel.status).toBe(404);

    /* Sales publishes the withdrawal; MERCHANDISING'S receiver mirrors it
       onto the file. Sales never touches the file itself — see the ownership
       suite, which proves the producer cannot even reach it. */
    const { correlationId } = await producer.cancel({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineId,
      reason: "Buyer cancelled the programme.", actor: { name: "Sales" },
    });
    await delivery.deliverPending({ companyId: w.co._id, correlationId });
    const stored = await ExecutionFile.findById(w.file.id).lean();
    expect(stored.lifecycleStatus).toBe("CANCELLED");
    expect(stored.cancellation.reason).toMatch(/cancelled the programme/);

    /* And Merchandising cannot move it back. */
    for (const cmd of ["hold", "resume", "close", "reopen"]) {
      const res = await move(w, cmd, { reason: "try", expectedRevision: stored.revision });
      expect([cmd, res.status]).toEqual([cmd, 409]);
    }
    const mirrored = await MerchandisingAuditEvent.findOne({ action: "SALES_CANCELLATION_MIRRORED" }).lean();
    expect(mirrored.source).toBe("sales");
  });

  test("generic PATCH cannot move the lifecycle or touch the projection", async () => {
    const w = await withFile("Lp");
    for (const [field, value] of [
      ["lifecycleStatus", "CLOSED"], ["currentExecutionProjection", {}],
      ["companyId", String(new mongoose.Types.ObjectId())], ["deliveries", []],
      ["responsibleMerchandiser", { email: "x@y.z" }], ["revision", 99],
    ]) {
      const res = await call(`/files/${w.file.id}`, {
        ...w.t, method: "PATCH", body: { expectedRevision: w.file.revision, [field]: value },
      });
      expect([field, res.status]).toEqual([field, 400]);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    /* What it CAN do: Merchandising's own note and tags. */
    const editor = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const ok = await call(`/files/${w.file.id}`, {
      token: editor.token, company: w.co._id, method: "PATCH",
      body: { expectedRevision: w.file.revision, coordinationNote: "Lab dips chased.", tags: ["priority"] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.file.coordinationNote).toBe("Lab dips chased.");
  });
});

/* ══ CAPABILITIES ═════════════════════════════════════════════════════════ */

describe("capabilities on the new surface", () => {
  test("viewer reads everything and mutates nothing; editor cannot review or move lifecycle", async () => {
    const w = await ready("Cp");
    const file = (await accept(w, w.version._id, w.t)).body.file;
    const viewer = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    const editor = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const tv = { token: viewer.token, company: w.co._id };
    const te = { token: editor.token, company: w.co._id };

    for (const path of ["/handovers", "/files?view=active", `/files/${file.id}`, `/files/${file.id}/history`, "/execution/overview"]) {
      expect([path, (await call(path, tv)).status]).toEqual([path, 200]);
    }
    /* Viewer: every mutation refused. */
    const v2 = await issued(w, { expectedCurrentVersionNo: 1 });
    for (const [path, body] of [
      [`/handovers/${v2._id}/accept`, {}],
      [`/handovers/${v2._id}/clarify`, { category: "OTHER", reason: "x" }],
      [`/files/${file.id}/lifecycle/hold`, { reason: "x", expectedRevision: 99 }],
      [`/files/${file.id}/assignments`, { email: viewer.email, expectedRevision: 99 }],
    ]) {
      const res = await call(path, { ...tv, method: "POST", body });
      expect([path, res.status]).toEqual([path, 403]);
    }
    const patch = await call(`/files/${file.id}`, { ...tv, method: "PATCH", body: { expectedRevision: 0 } });
    expect(patch.status).toBe(403);

    /* Editor: notes yes, decisions no. */
    expect((await call(`/handovers/${v2._id}/accept`, { ...te, method: "POST", body: {} })).status).toBe(403);
    expect((await call(`/files/${file.id}/lifecycle/hold`, {
      ...te, method: "POST", body: { reason: "x", expectedRevision: 99 },
    })).status).toBe(403);
  });

  test("an admin or Sales/CEO identity without a Merchandising grant is denied", async () => {
    const w = await ready("Cd");
    for (const opts of [
      { companies: [w.co], isAdmin: true },
      { companies: [w.co], tokenRole: "sales", grants: { sales: "owner" } },
      { companies: [w.co], tokenRole: "ceo", grants: { ceo: "owner" } },
    ]) {
      const who = await actor(opts);
      const t = { token: who.token, company: w.co._id };
      expect((await call("/handovers", t)).status).toBe(403);
      expect((await accept(w, w.version._id, t)).status).toBe(403);
    }
    expect(await ExecutionFile.countDocuments({})).toBe(0);
  });

  test("a revoked grant fails on the very next request", async () => {
    const w = await ready("Cr");
    expect((await call("/handovers", w.t)).status).toBe(200);
    await DepartmentRole.updateOne({ _id: w.approver.grantRows.merchandiser._id }, { $set: { isActive: false } });
    expect((await call("/handovers", w.t)).status).toBe(403);
    expect((await accept(w, w.version._id, w.t)).status).toBe(403);
  });
});

/* ══ PARITY, HISTORY AND PAGINATION ═══════════════════════════════════════ */

describe("overview parity and history", () => {
  test("every count equals the population its register view returns", async () => {
    const w = await world("Pv");
    const approver = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: approver.token, company: w.co._id };

    const v1 = await issued(w);
    /* A second company's world, to prove the counts cannot see it. */
    const other = await ready("PvOther");
    await accept(other, other.version._id, other.t);

    const f1 = (await accept(w, v1._id, t)).body.file;

    const overview1 = await call("/execution/overview", t);
    expect(overview1.body.counts.newHandovers).toBe(0);
    expect(overview1.body.counts.activeFiles).toBe(1);

    const active = await call("/files?view=active&limit=100", t);
    expect(active.body.rows).toHaveLength(overview1.body.counts.activeFiles);

    await call(`/files/${f1.id}/lifecycle/hold`, {
      ...t, method: "POST", body: { reason: "hold", expectedRevision: f1.revision },
    });
    const overview2 = await call("/execution/overview", t);
    expect(overview2.body.counts.activeFiles).toBe(0);
    expect(overview2.body.counts.onHoldFiles).toBe(1);
    const onHold = await call("/files?view=on-hold&limit=100", t);
    expect(onHold.body.rows).toHaveLength(1);

    /* Handed Over is honestly empty in M2 — the state is unreachable. */
    const handed = await call("/files?view=handed-over", t);
    expect(handed.body.rows).toEqual([]);
  });

  test("the file's history reads as events plus source lineage", async () => {
    const w = await ready("Hy");
    const file = (await accept(w, w.version._id, w.t)).body.file;
    await call(`/files/${file.id}/lifecycle/hold`, {
      ...w.t, method: "POST", body: { reason: "Awaiting artwork.", expectedRevision: file.revision },
    });

    const res = await call(`/files/${file.id}/history`, w.t);
    expect(res.status).toBe(200);
    const actions = res.body.events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["FILE_CREATED", "FILE_HELD"]));
    const held = res.body.events.find((e) => e.action === "FILE_HELD");
    expect(held.reason).toBe("Awaiting artwork.");
    expect(res.body.sourceVersions).toHaveLength(1);
    expect(res.body.sourceVersions[0].receiptState).toBe("ACCEPTED");
  });

  test("cursor pagination pages the register deterministically", async () => {
    const w = await world("Pg");
    const approver = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: approver.token, company: w.co._id };

    /* Five orders → five files in one company. */
    for (let i = 0; i < 5; i += 1) {
      const n = ++seq;
      const style = await SampleStyle.create({
        sampleStyleId: `SS-Pg-${n}`, styleCode: `SC-Pg-${n}`,
        productName: `Pg polo ${n}`, journeyId: w.style.journeyId, enquiryId: w.style.enquiryId,
        variantKey: `v${n}`, variantChosen: false,
      });
      const request = await CustomerRequest.create({
        requestId: `REQ-Pg-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
        customerInfo: { name: "Buyer" },
        items: [{ stockItemName: `Pg polo ${n}`, totalQuantity: 100, sampleStyleId: style._id }],
      });
      const { version } = await producer.issue({ companyId: w.co._id }, {
        requestId: String(request._id),
        lineId: String((await CustomerRequest.findById(request._id).lean()).items[0].lineRef),
        body: { expectedCurrentVersionNo: 0, deliveries: [{ committedDeliveryDate: "2026-12-01", quantity: 100 }] },
        actor: { name: "Sales" },
      });
      await accept(w, version._id, t);
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await call(`/files?view=active&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, t);
      expect(res.status).toBe(200);
      seen.push(...res.body.rows.map((r) => r.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    const bad = await call("/files?view=active&cursor=garbage", t);
    expect(bad.status).toBe(400);
    const badView = await call("/files?view=everything", t);
    expect(badView.status).toBe(400);
  });
});
