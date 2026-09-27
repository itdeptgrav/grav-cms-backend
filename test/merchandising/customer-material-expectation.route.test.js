// test/merchandising/customer-material-expectation.route.test.js
//
// WHAT THE CUSTOMER IS SENDING, ON A JOB-WORK ORDER — PHASE 1.
//
// Seven claims:
//
//   1  ELIGIBILITY IS A STORED FACT, ENFORCED ON THE SERVER. Only a file whose
//      OWN `currentExecutionProjection.fulfilmentModel` resolves to JOB_WORK may
//      carry one. A full-package file is REFUSED, not answered with an empty
//      list — a client that asks anyway must get the same answer as one that
//      does not, or the boundary is a suggestion. A file predating the field
//      reads as FULL_PACKAGE through the resolver, and is refused. And the
//      payload is never consulted: a request claiming JOB_WORK is ignored.
//
//   2  THREE STATES, AND THE TRANSITIONS BETWEEN THEM. Draft edits; issued
//      freezes; cancelled needs a reason. Nothing else exists — and above all no
//      state, field or word says anything has arrived.
//
//   3  LINE IDENTITIES ARE STABLE ACROSS REVISIONS. A revision carries its
//      lines' references forward, so "the interlining line" is the same line
//      throughout the order's life.
//
//   4  IDENTITY COMES FROM STORE'S CATALOGUE, AND QUANTITY FROM MERCHANDISING.
//      A client that sends a name is not refused; its name is not used. Which
//      material a line is for cannot be edited.
//
//   5  IT CARRIES NO PURCHASE. No vendor, no price, no currency, no tax, no
//      payable, no value — asserted on the JSON text, so a field added tomorrow
//      cannot arrive quietly.
//
//   6  TWO AUTHORITIES. Stating what is required is the editor's; issuing and
//      withdrawing it is the approver's, because that is the outward statement.
//
//   7  STORE READS IT AND CANNOT WRITE IT. The register and the detail are
//      reads; a draft answers as one that does not exist; and every response
//      says receipt recording is not available yet rather than showing an empty
//      column that reads as "nothing has arrived".
//
// And company isolation throughout: another company's file, document and
// register all answer as absent.
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
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  CustomerMaterialExpectation,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");

let server, base, storeBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "customer_material" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/customerMaterialRoute"));
  app.use("/api/cms/store/customer-materials", require("../../routes/CMS_Routes/StorePurchase/customerMaterials"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  storeBase = `http://127.0.0.1:${server.address().port}/api/cms/store/customer-materials`;
  await CustomerMaterialExpectation.syncIndexes();
  await RawItem.syncIndexes();
}, 120000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const req = (root) => (p, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${root}${p}`, {
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
    return { status: r.status, body: parsed, text };
  });

const call = (p, o) => req(base)(p, o);
const store = (p, o) => req(storeBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `cme-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `Me${n}`, email, biometricId: `CM${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    id: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

async function company() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `CME ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await Unit.create([
    { companyId: co._id, name: "Metre", status: "Active" },
    { companyId: co._id, name: "Kilogram", status: "Active" },
    { companyId: co._id, name: "Retired", status: "Inactive" },
  ]);
  return co;
}

/**
 * An execution file, written straight to the collection.
 *
 * This suite is about the EXPECTATION. An Execution File's own validation — the
 * handover version it came from, its delivery commitments, its quantities — is
 * the subject of that file's own suites, and stamping a plausible handover here
 * would mean inventing a commercial record to test a different one.
 *
 * `fulfilmentModel` is the one field that matters here, and `undefined` is a
 * deliberate case: it is what every file created before the field existed
 * carries, and the resolver must read it as FULL_PACKAGE.
 */
const OMIT = Symbol("omit the field entirely");
/**
 * The ownership chain an issued document must be able to walk:
 *
 *   ExecutionFile.currentHandoverVersionId
 *     → SalesHandoverVersion (company-scoped) .sourceRecord.recordId
 *       → CustomerRequest.customerId → Customer
 *
 * The handover version goes straight into its collection: this suite is about
 * the EXPECTATION, and a handover version's own validation — its projection,
 * its delivery commitments, its version numbering — is the subject of its own
 * suite. Stamping a plausible commercial record here to test an ownership link
 * would mean inventing the thing under test somewhere else.
 *
 * `broken` omits one link on purpose, because "the chain cannot be proven" is a
 * state real data is in: a request Sales has not yet attached a customer to.
 */
async function chain(co, { broken = "" } = {}) {
  const n = ++seq;
  const customer = broken === "customer" ? null : await Customer.create({
    name: `Buyer Person ${n}`, email: `cust${n}@grav.in`,
    customerId: `CUST-${n}`, profile: { companyName: `Buyer Trading ${n}` },
  });
  const request = await CustomerRequest.create({
    requestId: `CR-CME-${n}`,
    ...(customer ? { customerId: customer._id } : {}),
  });
  const versionId = new mongoose.Types.ObjectId();
  if (broken !== "handover") {
    await SalesHandoverVersion.collection.insertOne({
      _id: versionId,
      companyId: broken === "otherCompany" ? new mongoose.Types.ObjectId() : co._id,
      sourceRecord: {
        app: "sales", recordType: "customer_request",
        ...(broken === "sourceRecord" ? {} : { recordId: request._id }),
        sourceVersion: "1", issuedAt: new Date(),
      },
    });
  }
  return { customer, request, versionId };
}

async function file(co, { fulfilmentModel = "JOB_WORK", lifecycleStatus = "OPEN", broken = "" } = {}) {
  const n = ++seq;
  const _id = new mongoose.Types.ObjectId();
  const link = await chain(co, { broken });
  await ExecutionFile.collection.insertOne({
    _id, companyId: co._id, fileNumber: `MEF-CME-${n}`, handoverRef: `HO-CME-${n}`,
    handoverLineRef: `HOL-${n}`, executionPhase: "COORDINATION", lifecycleStatus,
    revision: 0,
    ...(broken === "noVersion" ? {} : { currentHandoverVersionId: link.versionId }),
    currentExecutionProjection: {
      orderRef: `ORD-CME-${n}`,
      buyerDisplayLabel: `Buyer ${n}`,
      productName: `Tee ${n}`,
      styleRef: `ST-${n}`,
      buyerStyleRef: `BST-${n}`,
      /* `OMIT` writes no field at all — what every file created before
         `fulfilmentModel` existed carries. Passing `undefined` would have
         selected the default above and silently tested JOB_WORK instead. */
      ...(fulfilmentModel === OMIT ? {} : { fulfilmentModel }),
    },
    createdAt: new Date(), updatedAt: new Date(),
  });
  return {
    _id, fileNumber: `MEF-CME-${n}`, orderRef: `ORD-CME-${n}`,
    customer: link.customer, request: link.request,
  };
}

/**
 * A raw item as STORE holds one — with the commercial facts written into it, so
 * "never returned" is proved against a record that really carries them.
 */
async function stock(co, over = {}) {
  const n = ++seq;
  return RawItem.create({
    companyId: co._id,
    name: over.name || `Customer poplin ${n}`,
    sku: over.sku || `RAW-FAB-CP-${n}`,
    category: "Fabric",
    usedAs: "FABRIC",
    unit: "Metre",
    attributes: over.attributes || [{ name: "Colour", values: ["Navy", "White"] }],
    variants: over.variants || [
      { combination: ["Navy"], sku: `RAW-FAB-CP-${n}-NV`, quantity: 0 },
      { combination: ["White"], sku: `RAW-FAB-CP-${n}-WH`, quantity: 0 },
    ],
    quantity: 0, minStock: 0, maxStock: 0,
    /* Everything below is Store's and must never cross. */
    discounts: [{ minQuantity: 500, price: 214.75 }],
    primaryVendor: new mongoose.Types.ObjectId(),
    budgetLedgerName: "Fabric purchases",
  });
}

const at = (co, who) => ({ token: who.token, company: co._id });

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    /* Store's own reader: the `store` department's weakest rung, which carries
       `sp.read` and nothing else. Deliberately no Merchandising grant — Store
       reads these through Store's door, under Store's own authority. */
    storekeeper: await actor({ companies: [co], grants: { store: "viewer" } }),
    /* A company member with no grant anywhere, for the refusals. */
    nobody: await actor({ companies: [co] }),
  };
}

const draftOn = (co, c, f, over = {}) => call(`/files/${f._id}/customer-materials`, {
  ...at(co, c[over.who || "editor"]), method: "POST", key: over.key || uniq(),
  body: { ...(over.fromRevisionNo !== undefined ? { fromRevisionNo: over.fromRevisionNo } : {}) },
});

const addLine = (co, c, docId, over = {}) => call(`/customer-materials/${docId}/lines`, {
  ...at(co, c[over.who || "editor"]), method: "POST", key: over.key || uniq(),
  body: {
    expectedRevision: over.expectedRevision,
    rawItemId: over.rawItemId,
    ...(over.variantId !== undefined ? { variantId: over.variantId } : {}),
    requiredQuantity: over.requiredQuantity !== undefined ? over.requiredQuantity : 1200,
    unit: over.unit !== undefined ? over.unit : "Metre",
    ...(over.expectedArrivalDate !== undefined ? { expectedArrivalDate: over.expectedArrivalDate } : {}),
    ...(over.note !== undefined ? { note: over.note } : {}),
    ...over.extra,
  },
});

/** A file with an issued single-line document, the usual starting point. */
async function issued(co, c, f) {
  const item = await stock(co);
  const d = await draftOn(co, c, f);
  const added = await addLine(co, c, d.body.expectation.id, {
    rawItemId: String(item._id),
    variantId: String(item.variants[0]._id),
    expectedRevision: d.body.expectation.revision,
  });
  const out = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
    ...at(co, c.approver), method: "POST", key: uniq(),
    body: { expectedRevision: added.body.expectation.revision },
  });
  return { item, doc: out.body.expectation };
}

/* ══ 1 — ELIGIBILITY ═════════════════════════════════════════════════════ */

describe("only a job-work order carries one", () => {
  test("a job-work file may open a draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { fulfilmentModel: "JOB_WORK" });

    const res = await draftOn(co, c, f);
    expect(res.status).toBe(201);
    expect(res.body.expectation.state).toBe("DRAFT");
    expect(res.body.expectation.fulfilmentModel).toBe("JOB_WORK");
    expect(res.body.expectation.orderRef).toBe(f.orderRef);
    expect(res.body.expectation.fileNumber).toBe(f.fileNumber);
  });

  test("a full-package file cannot compose one, and says so on the read", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { fulfilmentModel: "FULL_PACKAGE" });

    /* The READ answers. It used to refuse, and that was the bug: the model
       decides what may be WRITTEN, not whether the record can be looked at. */
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.status).toBe(200);
    expect(read.body.jobWork).toBe(false);
    expect(read.body.canCompose).toBe(false);
    expect(read.body.fulfilmentModel).toBe("FULL_PACKAGE");
    expect(read.body.history).toEqual([]);
    /* Never had one, so nothing "changed" — a different sentence from the
       converted case below. */
    expect(read.body.sourceChanged).toBe(false);

    const write = await draftOn(co, c, f);
    expect(write.status).toBe(409);
    expect(write.body.error.details.reason).toBe("NOT_A_JOB_WORK_ORDER");
    expect(await CustomerMaterialExpectation.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("a file predating the field reads as full package and cannot compose", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { fulfilmentModel: OMIT });

    const res = await draftOn(co, c, f);
    expect(res.status).toBe(409);
    expect(res.body.error.details.fulfilmentModel).toBe("FULL_PACKAGE");
    expect((await call(`/files/${f._id}/customer-materials`, at(co, c.editor))).status).toBe(200);
  });

  test("the payload cannot claim eligibility", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { fulfilmentModel: "FULL_PACKAGE" });

    const res = await call(`/files/${f._id}/customer-materials`, {
      ...at(co, c.editor), method: "POST", key: uniq(),
      body: { fulfilmentModel: "JOB_WORK" },
    });
    expect(res.status).toBe(409);
    expect(await CustomerMaterialExpectation.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("eligibility is re-checked on every write, not inherited from the draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { fulfilmentModel: "JOB_WORK" });
    const item = await stock(co);
    const d = await draftOn(co, c, f);

    /* The order is converted to full package while the draft is open. */
    await ExecutionFile.collection.updateOne(
      { _id: f._id },
      { $set: { "currentExecutionProjection.fulfilmentModel": "FULL_PACKAGE" } },
    );

    const res = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    expect(res.status).toBe(409);
    /* A DIFFERENT reason from "this is a full-package order": the document
       exists and Store is holding it, so the sentence has to say what changed
       rather than implying the screen was never meant to work. */
    expect(res.body.error.details.reason).toBe("SOURCE_FULFILMENT_MODEL_CHANGED");
  });

  test("a cancelled execution file takes no more work", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { lifecycleStatus: "CANCELLED" });
    const res = await draftOn(co, c, f);
    expect(res.status).toBe(409);
    expect(res.body.error.details.lifecycleStatus).toBe("CANCELLED");
  });

  test("another company's file answers as one that does not exist", async () => {
    const mine = await company();
    const theirs = await company();
    const c = await cast(mine);
    const foreign = await file(theirs, { fulfilmentModel: "JOB_WORK" });

    const res = await call(`/files/${foreign._id}/customer-materials`, at(mine, c.editor));
    expect(res.status).toBe(404);
  });
});

/* ══ WHOSE GOODS THESE ARE ═══════════════════════════════════════════════ */

describe("the customer is an identity, not a label", () => {
  test("it is walked from the handover chain and stamped on the document", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    expect(doc.customerId).toBe(String(f.customer._id));
    /* The label travels BESIDE the id, as a snapshot for reading the document
       back as it was — never as the thing anything joins on. */
    expect(doc.customer.label).toBe(f.customer.profile.companyName);
    expect(doc.customer.name).toBe(f.customer.name);
    expect(doc.customer.code).toBe(f.customer.customerId);
    expect(doc.customer.requestRef).toBe(f.request.requestId);

    const stored = await CustomerMaterialExpectation.findById(doc.id).lean();
    expect(String(stored.customerId)).toBe(String(f.customer._id));
    expect(String(stored.customerRequestId)).toBe(String(f.request._id));
  });

  test("a payload naming a customer is ignored, not merged", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const forged = await Customer.create({
      name: "Somebody Else", email: `forged-${++seq}@grav.in`, customerId: "CUST-FORGED",
    });
    const item = await stock(co);

    const d = await call(`/files/${f._id}/customer-materials`, {
      ...at(co, c.editor), method: "POST", key: uniq(),
      body: {
        customerId: String(forged._id),
        customerSnapshot: { customerLabel: "Somebody Else" },
        customerRequestId: String(new mongoose.Types.ObjectId()),
      },
    });
    expect(d.status).toBe(201);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    const out = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: {
        expectedRevision: added.body.expectation.revision,
        customerId: String(forged._id),
      },
    });
    expect(out.status).toBe(200);

    /* The walked chain wins. A client that could name the customer could move
       one customer's fabric onto another's book by editing a form. */
    expect(out.body.expectation.customerId).toBe(String(f.customer._id));
    expect(out.body.expectation.customerId).not.toBe(String(forged._id));
    expect(out.body.expectation.customer.label).not.toBe("Somebody Else");
  });

  test("a handover version belonging to another company proves nothing", async () => {
    const co = await company();
    const c = await cast(co);
    /* The file is this company's; the handover version it points at is not.
       `CustomerRequest` carries no companyId, so the boundary is held one link
       earlier — and this is the test that says so. */
    const f = await file(co, { broken: "otherCompany" });
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });

    const res = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("CUSTOMER_IDENTITY_UNPROVEN");
    expect(res.body.error.details.cause).toBe("HANDOVER_VERSION_NOT_FOUND");
  });

  test.each([
    ["the file names no handover version", "noVersion", "NO_HANDOVER_VERSION"],
    ["the handover version is missing", "handover", "HANDOVER_VERSION_NOT_FOUND"],
    ["the handover names no customer request", "sourceRecord", "SOURCE_RECORD_MISSING"],
    ["the request names no customer", "customer", "CUSTOMER_NOT_NAMED"],
  ])("issuing is refused when %s", async (_label, broken, cause) => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { broken });
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });

    const res = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("CUSTOMER_IDENTITY_UNPROVEN");
    expect(res.body.error.details.cause).toBe(cause);
    /* And it says what to do about it rather than only that it failed. */
    expect(res.body.message).toMatch(/cannot be held|put right|Ask Sales/i);

    const stored = await CustomerMaterialExpectation.findById(d.body.expectation.id).lean();
    expect(stored.state).toBe("DRAFT");
  });

  test("a draft may be composed while the chain is still broken", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { broken: "customer" });
    const item = await stock(co);

    /* A merchandiser is legitimately ahead of Sales attaching the customer.
       Stopping them from drafting would make them wait on somebody else to
       write down something they already know. */
    const d = await draftOn(co, c, f);
    expect(d.status).toBe(201);
    expect(d.body.expectation.customerId).toBeNull();
    expect((await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    })).status).toBe(201);

    /* And the read says why it cannot be issued yet, rather than letting
       somebody discover it at the moment they press the button. */
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.body.customerProven).toBe(false);
    expect(read.body.customerUnproven.reason).toBe("CUSTOMER_NOT_NAMED");
    expect(read.body.customerUnproven.message).toMatch(/Ask Sales/);
  });

  test("a chain repaired after the draft was opened simply works", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { broken: "customer" });
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });

    /* Sales attaches the customer — the actual repair. */
    const late = await Customer.create({
      name: "Attached Late", email: `late-${++seq}@grav.in`, customerId: "CUST-LATE",
    });
    await CustomerRequest.updateOne({ _id: f.request._id }, { $set: { customerId: late._id } });

    const res = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(200);
    /* Re-walked at issue rather than trusted from the draft, so the repair does
       not need anybody to know to delete the draft and start again. */
    expect(res.body.expectation.customerId).toBe(String(late._id));
  });

  test("withdrawal never needs a provable customer", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co, { broken: "customer" });
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });

    /* Otherwise a Phase 1 document with no customer attached could never be
       cleared off Store's register. */
    const res = await call(`/customer-materials/${d.body.expectation.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision, reason: "Not needed." },
    });
    expect(res.status).toBe(200);
    expect(res.body.expectation.state).toBe("CANCELLED");
  });

  test("the snapshot carries no tax registration, address or contact", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    await Customer.updateOne({ _id: f.customer._id }, {
      $set: { gstNumber: "29ABCDE1234F1Z5", phone: "9999999999" },
    });
    const { doc } = await issued(co, c, f);

    /* Ownership needs to say WHOSE goods these are. It does not need the
       customer's tax registration, and a screen that had one would show it. */
    const text = JSON.stringify(doc);
    expect(text).not.toContain("29ABCDE1234F1Z5");
    expect(text).not.toContain("9999999999");
    expect(Object.keys(doc.customer).sort())
      .toEqual(["code", "id", "label", "name", "requestRef"]);
  });
});

/* ══ 2 — THE THREE STATES ════════════════════════════════════════════════ */

describe("draft, issued, cancelled — and nothing else", () => {
  test("a draft is editable and an issued revision is not", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc, item } = await issued(co, c, f);
    expect(doc.state).toBe("ISSUED");
    expect(doc.issuedBy.email).toBe(c.approver.email);
    expect(doc.issuedAt).toBeTruthy();

    const res = await addLine(co, c, doc.id, {
      rawItemId: String(item._id), expectedRevision: doc.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Open a new revision/);
  });

  test("an empty document cannot be issued", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const d = await draftOn(co, c, f);

    const res = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: d.body.expectation.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("NO_LINES");
  });

  test("cancelling needs a reason Store can act on", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    const without = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision },
    });
    expect(without.status).toBe(400);
    expect(without.body.error.details.field).toBe("reason");

    const withReason = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Buyer is sourcing it themselves now." },
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.expectation.state).toBe("CANCELLED");
    expect(withReason.body.expectation.cancellationReason)
      .toBe("Buyer is sourcing it themselves now.");
    /* The lines stay. What was expected is part of the order's history even
       when it stopped being expected. */
    expect(withReason.body.expectation.lines).toHaveLength(1);
  });

  test("a cancelled document is read-only and cannot be cancelled twice", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    const done = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Withdrawn." },
    });
    const again = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: done.body.expectation.revision, reason: "Again." },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_TRANSITION");
  });

  test("a document whose order became full package can still be withdrawn", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    await ExecutionFile.collection.updateOne(
      { _id: f._id },
      { $set: { "currentExecutionProjection.fulfilmentModel": "FULL_PACKAGE" } },
    );
    /* Refusing the withdrawal because the order changed would strand it in
       ISSUED for ever — and the conversion is one of the reasons to withdraw. */
    /* Still readable, and it says the source moved — which is the whole point
       of the correction: Store was planning around this document. */
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.status).toBe(200);
    expect(read.body.sourceChanged).toBe(true);
    expect(read.body.canCompose).toBe(false);
    expect(read.body.current.id).toBe(doc.id);

    const res = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Order converted to full package." },
    });
    expect(res.status).toBe(200);
    expect(res.body.expectation.state).toBe("CANCELLED");
  });

  test("only one draft is ever open for a file", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);

    const first = await draftOn(co, c, f, { key: uniq() });
    expect(first.status).toBe(201);
    /* A DIFFERENT key, so this is not a replay — it is a second attempt, and it
       gets the open draft back rather than creating a rival. */
    const second = await draftOn(co, c, f, { key: uniq() });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.expectation.id).toBe(first.body.expectation.id);
    expect(await CustomerMaterialExpectation.countDocuments({
      companyId: co._id, state: "DRAFT",
    })).toBe(1);
  });

  test("two simultaneous draft requests produce one draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);

    const all = await Promise.all([
      draftOn(co, c, f, { key: uniq() }),
      draftOn(co, c, f, { key: uniq() }),
      draftOn(co, c, f, { key: uniq() }),
    ]);
    expect(all.every((r) => r.status < 400)).toBe(true);
    const ids = new Set(all.map((r) => r.body.expectation.id));
    expect(ids.size).toBe(1);
    expect(await CustomerMaterialExpectation.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("a stale expectedRevision is refused rather than overwriting", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    /* Composed against the revision before the line was added. */
    const stale = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String((await stock(co))._id), expectedRevision: d.body.expectation.revision,
    });
    expect(stale.status).toBe(409);
    /* 409 and `CONFLICT`, not 400: nothing about the request is malformed — the
       record moved underneath it, and re-sending it unchanged would fail again.
       Telling somebody to check the form would be unfixable advice. */
    expect(stale.body.error.code).toBe("CONFLICT");
    expect(stale.body.error.details.expected).toBe(0);
    expect(stale.body.error.details.actual).toBe(1);
  });

  test("the document's own state never becomes a receipt state", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    /* ── THE TWO LIFECYCLES STAY APART ──────────────────────────────────
       `DRAFT / ISSUED / CANCELLED` is what somebody DECIDED to state. Receipt
       standing is what has physically happened. Folding them into one field
       would mean an issued document turning itself into "RECEIVED", after which
       nothing can distinguish "Merchandising has stated this" from "the goods
       are here" — and those have different owners and different evidence. */
    expect(doc.state).toBe("ISSUED");
    const states = ["DRAFT", "ISSUED", "CANCELLED"];
    expect(states).toContain(doc.state);
    for (const notAState of ["RECEIVED", "PARTIALLY_RECEIVED", "SHORT_CLOSED", "NOT_RECEIVED"]) {
      expect(doc.state).not.toBe(notAState);
    }
    /* And the document view itself carries no received figure — progress is
       derived beside it, never stored on it. */
    expect(doc.receivedQuantity).toBeUndefined();
    expect(doc.lines[0].receivedQuantity).toBeUndefined();
  });

  test("nothing about receipt is ever stored on the expectation", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    /* A stored counter is a second source of truth that drifts the first time a
       receipt is voided or a transaction half-commits — and drifts silently,
       because nothing recomputes it to notice. */
    const stored = await CustomerMaterialExpectation.findById(doc.id).lean();
    const text = JSON.stringify(stored);
    for (const banned of [
      "receivedQuantity", "received_quantity", "outstandingQuantity",
      "pendingQuantity", "receiptStatus", "goodsReceiptId", "grnRef",
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(stored.lines[0].receivedQuantity).toBeUndefined();
  });

  test("progress is reported beside the document, derived and starting at nothing", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    await issued(co, c, f);
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));

    /* Receipt recording IS available now — the Phase 1 notice that said it was
       not has been replaced by the figure it was standing in for. */
    expect(read.body.receipt.available).toBe(true);
    expect(read.body.standing.standing).toBe("NOT_RECEIVED");
    expect(read.body.standing.nextOwner).toBe("STORE");
    expect(read.body.standing.lines[0]).toMatchObject({
      requiredQuantity: 1200, receivedQuantity: 0, pendingQuantity: 1200,
      status: "NOT_RECEIVED", receiptCount: 0,
    });
    expect(read.body.standing.latestReceipt).toBeNull();
  });
});

/* ══ 3 — REVISIONS AND STABLE LINE IDENTITIES ════════════════════════════ */

describe("a revision is the same document, changed", () => {
  test("it carries the issued lines forward with their references intact", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    const firstLineRef = doc.lines[0].lineRef;

    const rev = await draftOn(co, c, f, { fromRevisionNo: doc.revisionNo });
    expect(rev.status).toBe(201);
    expect(rev.body.expectation.revisionNo).toBe(2);
    expect(rev.body.expectation.state).toBe("DRAFT");
    expect(rev.body.expectation.revisedFromRevisionNo).toBe(1);
    /* The same document reference — revision 2 of CSM-n, not a new code that
       would hide that it is the same document. */
    expect(rev.body.expectation.documentRef).toBe(doc.documentRef);
    /* And the same LINE. "The interlining line" survives the revision. */
    expect(rev.body.expectation.lines[0].lineRef).toBe(firstLineRef);
  });

  test("changing a quantity in a revision does not change what was issued", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });

    await call(`/customer-materials/${rev.body.expectation.id}/lines/${doc.lines[0].lineRef}`, {
      ...at(co, c.editor), method: "PUT", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision, requiredQuantity: 1500 },
    });

    const all = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    const issuedOne = all.body.history.find((d) => d.revisionNo === 1);
    expect(issuedOne.lines[0].requiredQuantity).toBe(1200);
    const draftOne = all.body.draft;
    expect(draftOne.lines[0].requiredQuantity).toBe(1500);
  });

  test("the current issued revision is the highest-numbered one", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    const issuedRev = await call(`/customer-materials/${rev.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision },
    });
    expect(issuedRev.status).toBe(200);

    const all = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(all.body.current.revisionNo).toBe(2);
    expect(all.body.draft).toBeNull();
    expect(all.body.history.map((d) => d.revisionNo)).toEqual([2, 1]);
    /* No SUPERSEDED state — revision 1 is still ISSUED, and "current" is
       derived rather than stored. */
    expect(all.body.history.every((d) => d.state === "ISSUED")).toBe(true);
    expect(doc.revisionNo).toBe(1);
  });

  test("a cancelled revision cannot be revised from", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Withdrawn." },
    });

    const res = await draftOn(co, c, f, { fromRevisionNo: 1 });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not an issued revision/);
  });

  test("a revision number that does not exist is refused", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    await issued(co, c, f);
    const res = await draftOn(co, c, f, { fromRevisionNo: 7 });
    expect(res.status).toBe(404);
  });
});

/* ══ A REVISION MEETS WHAT HAS ALREADY ARRIVED ═══════════════════════════ */

describe("revisions after goods have been received", () => {
  /**
   * A receipt, written straight to the collection.
   *
   * This suite is about the REVISION RULES. The receipt path — the stock
   * movement, the ownership lot, the transaction — is the subject of its own
   * suite, and driving it through HTTP here would make these tests fail for
   * reasons that have nothing to do with what they claim.
   */
  const receiptFor = (co, doc, lineRef, quantity, againstRevisionNo = 1) => GoodsReceipt.create({
    companyId: co._id,
    receiptNumber: `GRN/TEST/${String(++seq).padStart(4, "0")}`,
    sourceType: "CUSTOMER_MATERIAL",
    sourceDocumentId: doc.id,
    sourceDocumentNumber: doc.documentRef,
    status: "RECORDED",
    receiptDate: new Date(),
    customerMaterial: {
      customerId: doc.customerId,
      expectationRevisionNo: againstRevisionNo,
      orderRef: doc.orderRef,
    },
    lines: [{
      sourceLineRef: lineRef, receivedQuantity: quantity,
      poUnit: "Metre", baseUnit: "Metre", baseQuantity: quantity,
    }],
  });

  /** An issued document with one receipt against its only line. */
  async function received(co, c, f, quantity = 400) {
    const { doc, item } = await issued(co, c, f);
    await receiptFor(co, doc, doc.lines[0].lineRef, quantity);
    return { doc, item, lineRef: doc.lines[0].lineRef };
  }

  test("an earlier receipt still counts against the later revision's line", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc, lineRef } = await received(co, c, f, 400);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    /* The same lineRef, carried forward — which is the whole reason the receipt
       against revision 1 is still about this line. */
    expect(rev.body.expectation.lines[0].lineRef).toBe(lineRef);

    const out = await call(`/customer-materials/${rev.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision },
    });
    expect(out.status).toBe(200);

    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.body.current.revisionNo).toBe(2);
    expect(read.body.standing.lines[0]).toMatchObject({
      requiredQuantity: 1200, receivedQuantity: 400, pendingQuantity: 800,
      status: "PARTIALLY_RECEIVED",
    });
    /* And the provenance still names the revision it was measured against. */
    expect(read.body.standing.lines[0].receiptHistory[0].againstRevisionNo).toBe(1);
    expect(doc.revisionNo).toBe(1);
  });

  test("a revision cannot require less than has already arrived", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { lineRef } = await received(co, c, f, 900);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    await call(`/customer-materials/${rev.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "PUT", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision, requiredQuantity: 500 },
    });

    /* Refused at ISSUE, not while drafting: a draft is where somebody works
       things out, and refusing a keystroke because of a receipt would make the
       document unusable. */
    const out = await call(`/customer-materials/${rev.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision + 1 },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.details.reason).toBe("REQUIREMENT_BELOW_RECEIVED");
    expect(out.body.error.details.receivedQuantity).toBe(900);
    expect(out.body.message).toMatch(/Short close/);

    const stored = await CustomerMaterialExpectation.findById(rev.body.expectation.id).lean();
    expect(stored.state).toBe("DRAFT");
  });

  test("increasing the requirement simply increases what is pending", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { lineRef } = await received(co, c, f, 400);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    await call(`/customer-materials/${rev.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "PUT", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision, requiredQuantity: 2000 },
    });
    const out = await call(`/customer-materials/${rev.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision + 1 },
    });
    expect(out.status).toBe(200);

    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.body.standing.lines[0]).toMatchObject({
      requiredQuantity: 2000, receivedQuantity: 400, pendingQuantity: 1600,
    });
  });

  test("a line with receipts cannot be removed from the draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { lineRef } = await received(co, c, f, 400);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    /* Refused at the moment somebody tries, rather than after composing a whole
       revision around it. The goods are on the shelf and an ownership lot names
       this line. */
    const res = await call(`/customer-materials/${rev.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "DELETE", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("RECEIVED_LINE_REMOVED");
    expect(res.body.message).toMatch(/Short close/);
  });

  test("and a revision that drops it some other way is refused at issue", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { lineRef } = await received(co, c, f, 400);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    /* Written straight out of the draft, as an edit made outside the guarded
       path would. The issue gate is the backstop. */
    await CustomerMaterialExpectation.updateOne(
      { _id: rev.body.expectation.id },
      { $pull: { lines: { lineRef } }, $inc: { revision: 1 } },
    );
    /* A second line, so the document is not empty for a different reason. */
    const other = await stock(co);
    await addLine(co, c, rev.body.expectation.id, {
      rawItemId: String(other._id),
      expectedRevision: rev.body.expectation.revision + 1,
    });

    const fresh = await CustomerMaterialExpectation.findById(rev.body.expectation.id).lean();
    const out = await call(`/customer-materials/${rev.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: fresh.revision },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.details.reason).toBe("RECEIVED_LINE_REMOVED");
    expect(out.body.error.details.receivedQuantity).toBe(400);
  });

  test("a received line's material cannot be replaced", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { lineRef } = await received(co, c, f, 400);
    const other = await stock(co);

    const rev = await draftOn(co, c, f, { fromRevisionNo: 1 });
    /* Two doors, both shut: changing the identity in place is refused outright,
       and remove-and-add is refused because the line has receipts. So a received
       line's material is settled — which it must be, because the lot on the shelf
       describes that material. */
    const swap = await call(`/customer-materials/${rev.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "PUT", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision, rawItemId: String(other._id) },
    });
    expect(swap.status).toBe(400);
    expect(swap.body.error.details.reason).toBe("LINE_IDENTITY_NOT_EDITABLE");

    const remove = await call(`/customer-materials/${rev.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "DELETE", key: uniq(),
      body: { expectedRevision: rev.body.expectation.revision },
    });
    expect(remove.status).toBe(409);
  });

  test("a line with no receipts may still be freely removed", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    const res = await call(`/customer-materials/${d.body.expectation.id}/lines/${added.body.expectation.lines[0].lineRef}`, {
      ...at(co, c.editor), method: "DELETE", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(200);
  });

  test("a voided receipt stops counting", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc, lineRef } = await received(co, c, f, 400);
    await GoodsReceipt.updateMany({ companyId: co._id }, { $set: { status: "VOID" } });

    /* A voided receipt is one that should never have counted. Holding a line
       closed against goods nobody has would be worse than reopening it. */
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));
    expect(read.body.standing.lines[0]).toMatchObject({
      receivedQuantity: 0, pendingQuantity: 1200, status: "NOT_RECEIVED",
    });
    expect(doc.documentRef).toBeTruthy();
    expect(lineRef).toBeTruthy();
  });
});

/* ══ 4 — IDENTITY IS STORE'S, QUANTITY IS MERCHANDISING'S ════════════════ */

describe("what a line is for, and what a line says", () => {
  test("the server writes the identity, whatever the client sent", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co, { name: "Customer poplin 120" });
    const d = await draftOn(co, c, f);

    const res = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id),
      variantId: String(item.variants[0]._id),
      expectedRevision: d.body.expectation.revision,
      extra: { rawItemName: "WHATEVER THE BROWSER FELT LIKE", rawItemSku: "NOT-REAL" },
    });
    expect(res.status).toBe(201);
    const line = res.body.expectation.lines[0];
    expect(line.rawItemName).toBe("Customer poplin 120");
    expect(line.rawItemSku).toBe(item.variants[0].sku);
    expect(line.variantCombination).toEqual(["Navy"]);
  });

  test("which material a line is for cannot be edited", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const other = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    const lineRef = added.body.expectation.lines[0].lineRef;

    const res = await call(`/customer-materials/${d.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "PUT", key: uniq(),
      body: {
        expectedRevision: added.body.expectation.revision,
        rawItemId: String(other._id),
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("LINE_IDENTITY_NOT_EDITABLE");
  });

  test("a quantity of zero is refused, because removing the line says it plainly", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);

    for (const q of [0, -5, "", null, "abc"]) {
      const res = await addLine(co, c, d.body.expectation.id, {
        rawItemId: String(item._id), requiredQuantity: q,
        expectedRevision: d.body.expectation.revision,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("requiredQuantity");
    }
  });

  test("a unit this company has not got is refused", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);

    for (const unit of ["Furlong", "Retired", ""]) {
      const res = await addLine(co, c, d.body.expectation.id, {
        rawItemId: String(item._id), unit,
        expectedRevision: d.body.expectation.revision,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("unit");
    }
  });

  test("the unit is stored in Store's own spelling", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const res = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), unit: "mEtRe",
      expectedRevision: d.body.expectation.revision,
    });
    expect(res.body.expectation.lines[0].unit).toBe("Metre");
  });

  test("the same material twice on one document is refused", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const first = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      expectedRevision: d.body.expectation.revision,
    });
    const again = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      expectedRevision: first.body.expectation.revision,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe("MATERIAL_ALREADY_ON_DOCUMENT");

    /* A different variant of the same item IS a different material. */
    const other = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), variantId: String(item.variants[1]._id),
      expectedRevision: first.body.expectation.revision,
    });
    expect(other.status).toBe(201);
  });

  test("another company's material cannot be put on a line", async () => {
    const mine = await company();
    const theirs = await company();
    const c = await cast(mine);
    const f = await file(mine);
    const foreign = await stock(theirs);
    const d = await draftOn(mine, c, f);

    const res = await addLine(mine, c, d.body.expectation.id, {
      rawItemId: String(foreign._id), expectedRevision: d.body.expectation.revision,
    });
    expect(res.status).toBe(404);
  });

  test("an expected arrival date is optional and a bad one is refused", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);

    const none = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    expect(none.body.expectation.lines[0].expectedArrivalDate).toBeNull();

    const bad = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String((await stock(co))._id), expectedArrivalDate: "not-a-date",
      expectedRevision: none.body.expectation.revision,
    });
    expect(bad.status).toBe(400);
  });

  test("a line can be removed from a draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const added = await addLine(co, c, d.body.expectation.id, {
      rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    const lineRef = added.body.expectation.lines[0].lineRef;

    const res = await call(`/customer-materials/${d.body.expectation.id}/lines/${lineRef}`, {
      ...at(co, c.editor), method: "DELETE", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(200);
    expect(res.body.expectation.lines).toHaveLength(0);
  });
});

/* ══ 5 — NO PURCHASE ANYWHERE NEAR IT ════════════════════════════════════ */

describe("it is not a purchase order", () => {
  test("no vendor, price, currency, tax, payable or value comes back", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    await issued(co, c, f);
    const read = await call(`/files/${f._id}/customer-materials`, at(co, c.editor));

    for (const banned of [
      "vendor", "supplier", "price", "rate", "unitCost", "currency", "amount",
      "taxRate", "gst", "hsn", "payable", "paymentTerm", "purchaseValue",
      "discount", "budgetLedger", "poNumber", "purchaseOrder",
    ]) {
      expect(read.text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  test("the model has nowhere for one to land", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../models/CMS_Models/Merchandising/CustomerMaterialExpectation.js"),
      "utf8",
    );
    /* Field declarations only — the header discusses these words at length on
       purpose, and a test that banned the discussion would delete the reason. */
    const fields = src.slice(src.indexOf("const lineSchema"));
    for (const banned of [
      /^\s*vendor\w*\s*:/m, /^\s*price\s*:/m, /^\s*rate\s*:/m, /^\s*currency\s*:/m,
      /^\s*taxRate\s*:/m, /^\s*gst\w*\s*:/m, /^\s*payable\s*:/m, /^\s*amount\s*:/m,
      /^\s*receivedQuantity\s*:/m, /^\s*receiptState\s*:/m,
    ]) {
      expect(fields).not.toMatch(banned);
    }
  });

  test("the only states are the three this phase supports", () => {
    const { STATES } = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
    expect([...STATES].sort()).toEqual(["CANCELLED", "DRAFT", "ISSUED"]);
  });
});

/* ══ 6 — TWO AUTHORITIES ════════════════════════════════════════════════ */

describe("who may state it, and who may issue it", () => {
  test("a viewer may read and may not draft", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);

    expect((await call(`/files/${f._id}/customer-materials`, at(co, c.viewer))).status).toBe(200);
    expect((await draftOn(co, c, f, { who: "viewer" })).status).toBe(403);
  });

  test("an editor may state what is required and may not issue it", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);

    const d = await draftOn(co, c, f, { who: "editor" });
    expect(d.status).toBe(201);
    const added = await addLine(co, c, d.body.expectation.id, {
      who: "editor", rawItemId: String(item._id),
      expectedRevision: d.body.expectation.revision,
    });
    expect(added.status).toBe(201);

    /* Composing a document and committing to it are different acts. */
    const res = await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: added.body.expectation.revision },
    });
    expect(res.status).toBe(403);
    const stored = await CustomerMaterialExpectation.findById(d.body.expectation.id).lean();
    expect(stored.state).toBe("DRAFT");
  });

  test("an editor may not withdraw an issued document either", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    const res = await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Trying." },
    });
    expect(res.status).toBe(403);
  });

  test("somebody with no Merchandising grant reads nothing here", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const res = await call(`/files/${f._id}/customer-materials`, at(co, c.nobody));
    expect(res.status).toBe(403);
    /* And Store's own grant does not open Merchandising's door either. */
    expect((await call(`/files/${f._id}/customer-materials`, at(co, c.storekeeper))).status)
      .toBe(403);
  });
});

/* ══ 7 — STORE READS IT ═════════════════════════════════════════════════ */

describe("Store's register and detail", () => {
  test("an issued document appears, with its receipt standing", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    const reg = await store("/", at(co, c.storekeeper));
    expect(reg.status).toBe(200);
    expect(reg.body.rows.map((r) => r.id)).toEqual([doc.id]);
    expect(reg.body.rows[0].orderRef).toBe(f.orderRef);
    /* Receipt recording is available, and the register says where each document
       stands rather than saying it cannot tell. */
    expect(reg.body.receipt.available).toBe(true);
    expect(reg.body.rows[0].standing.standing).toBe("NOT_RECEIVED");

    const detail = await store(`/${doc.id}`, at(co, c.storekeeper));
    expect(detail.status).toBe(200);
    expect(detail.body.expectation.lines).toHaveLength(1);
    expect(detail.body.standing.lines[0].pendingQuantity).toBe(1200);
    expect(detail.body.standing.nextOwner).toBe("STORE");
  });

  test("a draft answers as one that does not exist", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const d = await draftOn(co, c, f);

    const reg = await store("/", at(co, c.storekeeper));
    expect(reg.body.rows).toHaveLength(0);
    expect(reg.body.total).toBe(0);

    const detail = await store(`/${d.body.expectation.id}`, at(co, c.storekeeper));
    expect(detail.status).toBe(404);
    /* Not "you may not see it" — that would tell Store one is being written. */
    expect(detail.body.message).toMatch(/was not found/);
  });

  test("Store keeps seeing an issued document after the order is converted", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    await ExecutionFile.collection.updateOne(
      { _id: f._id },
      { $set: { "currentExecutionProjection.fulfilmentModel": "FULL_PACKAGE" } },
    );

    /* Store planned around this and the customer was told. Hiding it at the
       moment it becomes contentious is the opposite of what a record is for. */
    const reg = await store("/", at(co, c.storekeeper));
    expect(reg.body.rows.map((r) => r.id)).toEqual([doc.id]);
    const detail = await store(`/${doc.id}`, at(co, c.storekeeper));
    expect(detail.status).toBe(200);
    expect(detail.body.expectation.state).toBe("ISSUED");
  });

  test("a withdrawal is visible, because that is what Store needs to know", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Buyer shipping direct to the mill." },
    });

    const reg = await store("/", at(co, c.storekeeper));
    expect(reg.body.rows).toHaveLength(1);
    expect(reg.body.rows[0].state).toBe("CANCELLED");
    expect(reg.body.rows[0].cancellationReason).toBe("Buyer shipping direct to the mill.");
  });

  test("asking for drafts is refused rather than silently returning none", async () => {
    const co = await company();
    const c = await cast(co);
    const res = await store("/?state=DRAFT", at(co, c.storekeeper));
    expect(res.status).toBe(400);
    expect(res.body.error.details.allowed).toEqual(["ISSUED", "CANCELLED"]);
  });

  test("the register searches by order, document and style", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    for (const q of [doc.documentRef, f.orderRef, f.fileNumber]) {
      const res = await store(`/?q=${encodeURIComponent(q)}`, at(co, c.storekeeper));
      expect(res.body.rows.map((r) => r.id)).toEqual([doc.id]);
    }
    const miss = await store("/?q=nothing-like-this", at(co, c.storekeeper));
    expect(res_empty(miss)).toBe(true);
  });

  test("another company's documents are not in this company's register", async () => {
    const mine = await company();
    const theirs = await company();
    const mc = await cast(mine);
    const tc = await cast(theirs);
    await issued(theirs, tc, await file(theirs));
    const ours = await issued(mine, mc, await file(mine));

    const reg = await store("/", at(mine, mc.storekeeper));
    expect(reg.body.rows.map((r) => r.id)).toEqual([ours.doc.id]);
  });

  test("Store has no write door at all", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);

    for (const [method, path] of [
      ["POST", "/"], ["PUT", `/${doc.id}`], ["DELETE", `/${doc.id}`],
      ["POST", `/${doc.id}/receive`], ["POST", `/${doc.id}/issue`],
    ]) {
      const res = await store(path, { ...at(co, c.storekeeper), method, body: {} });
      /* No handler, so Express answers 404 — not a 403 that would imply a door
         somebody could be granted. */
      expect(res.status).toBe(404);
    }
  });
});

const res_empty = (r) => r.body.rows.length === 0 && r.body.total === 0;

/* ══ THE AUDIT TRAIL ════════════════════════════════════════════════════ */

describe("every act is on the record", () => {
  test("drafting, adding, issuing and cancelling each leave a row on the file", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const { doc } = await issued(co, c, f);
    await call(`/customer-materials/${doc.id}/cancel`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: doc.revision, reason: "Withdrawn." },
    });

    const rows = await MerchandisingAuditEvent.find({
      companyId: co._id, recordType: "CUSTOMER_MATERIAL_EXPECTATION",
    }).sort({ at: 1 }).lean();

    expect(rows.map((r) => r.action)).toEqual([
      "CUSTOMER_MATERIAL_DRAFTED",
      "CUSTOMER_MATERIAL_LINE_ADDED",
      "CUSTOMER_MATERIAL_ISSUED",
      "CUSTOMER_MATERIAL_CANCELLED",
    ]);
    /* On the EXECUTION file, so the file's own history shows them rather than
       only a register nobody opens. */
    for (const r of rows) {
      expect(String(r.fileId)).toBe(String(f._id));
      expect(r.fileNumber).toBe(f.fileNumber);
      expect(r.source).toBe("merchandising");
      expect(r.correlationId).toBeTruthy();
    }
    expect(rows[2].actor.email).toBe(c.approver.email);
    expect(rows[3].reason).toBe("Withdrawn.");
    expect(rows[3].previousState).toBe("ISSUED");
    expect(rows[3].resultingState).toBe("CANCELLED");
  });

  test("a revision says what it was revised from", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    await issued(co, c, f);
    await draftOn(co, c, f, { fromRevisionNo: 1 });

    const row = await MerchandisingAuditEvent.findOne({
      companyId: co._id, action: "CUSTOMER_MATERIAL_REVISED",
    }).lean();
    expect(row).toBeTruthy();
    expect(row.details.revisedFromRevisionNo).toBe(1);
    expect(row.details.carriedLines).toBe(1);
    expect(row.details.revisionNo).toBe(2);
  });

  test("a refused act leaves no audit row", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const d = await draftOn(co, c, f);
    /* Issuing an empty document. */
    await call(`/customer-materials/${d.body.expectation.id}/issue`, {
      ...at(co, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: d.body.expectation.revision },
    });
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: co._id, action: "CUSTOMER_MATERIAL_ISSUED",
    })).toBe(0);
  });

  test("a retry replays rather than acting twice", async () => {
    const co = await company();
    const c = await cast(co);
    const f = await file(co);
    const item = await stock(co);
    const d = await draftOn(co, c, f);
    const key = uniq();

    const first = await addLine(co, c, d.body.expectation.id, {
      key, rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    expect(first.status).toBe(201);
    const retry = await addLine(co, c, d.body.expectation.id, {
      key, rawItemId: String(item._id), expectedRevision: d.body.expectation.revision,
    });
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.expectation.lines).toHaveLength(1);

    const stored = await CustomerMaterialExpectation.findById(d.body.expectation.id).lean();
    expect(stored.lines).toHaveLength(1);
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: co._id, action: "CUSTOMER_MATERIAL_LINE_ADDED",
    })).toBe(1);
  });
});
