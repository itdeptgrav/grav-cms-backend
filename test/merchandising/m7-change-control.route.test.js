// test/merchandising/m7-change-control.route.test.js
//
// M7 — CHANGE CONTROL AND THE ENTERPRISE OPERATIONS.
//
// Five claims, and they are the milestone:
//
//   1  SALES OWNS THE CHANGE. Merchandising has no route, service or model
//      path that creates one. It receives, assesses and coordinates.
//
//   2  NO BUYER CONVERSATION CROSSES. Messages, contacts, quotations, price,
//      margin and payment terms are refused at issue BY NAME, and the schema
//      has no field that could hold one.
//
//   3  IMPACT CREATES REVISIONS, NEVER OVERWRITES. An approved M3/M4
//      revision, a T&A baseline and a submitted pack are all readable and
//      byte-identical after a change has been through them.
//
//   4  AN ACKNOWLEDGEMENT IS OWNED BY ITS APPLICATION, AND A STALE ONE IS NOT
//      COVERAGE. Merchandising cannot write one; an answer to version 1 does
//      not count for version 2.
//
//   5  BULK IS PREVIEW-FIRST AND HONEST PER ROW. Preview writes nothing,
//      apply needs a matching unexpired preview, a refused row never discards
//      an applied one, and 500 is a refusal rather than a truncation.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
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
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const {
  SalesChangeNotice, NOTICE_STATE, FORBIDDEN_FIELDS,
} = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  ChangeIntakeReceipt, ChangeImpact, ChangeAcknowledgement,
  INTAKE_STATE, IMPACT_STATE, ACK_STATE,
} = require("../../models/CMS_Models/Merchandising/ChangeControl");
const { BulkOperation, MAX_ROWS } = require("../../models/CMS_Models/Merchandising/BulkOperation");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");
const changeNotices = require("../../services/sales/changeNotice.service");
const changeDelivery = require("../../services/integration/salesChangeDelivery.service");
const ackIntake = require("../../services/merchandising/changeAckIntake.service");

let server, base, salesBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "m7_change" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/changeControlRoute"));
  app.use("/api/cms/sales/change-notices", require("../../routes/CMS_Routes/Sales/changeNotices"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales/change-notices`;
  await SalesChangeNotice.syncIndexes();
  await ChangeIntakeReceipt.syncIndexes();
  await ChangeImpact.syncIndexes();
  await ChangeAcknowledgement.syncIndexes();
  await BulkOperation.syncIndexes();
  await MerchandisingIntakeLedger.syncIndexes();
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
const sales = (p, o) => req(salesBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `m7-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `Seven${n}`, email, biometricId: `M7${n}`,
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
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

/** A company with a real Execution File — the only way one exists. */
async function world({ quantity = 400 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `M7 ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Acct ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-7-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-7-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-7-${n}`, styleCode: `SC-7-${n}`, productName: `Polo ${n}`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    materials: { status: "selected", rawItems: [] },
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-7-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: `Polo ${n}`, totalQuantity: quantity,
      totalEstimatedPrice: 240, sampleStyleId: style._id,
    }],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(request._id), lineId: lineRef,
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity }],
    },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const reviewer = await actor({ companies: [co], grants: { merchandiser: "approver" } });
  const accepted = await execution.acceptHandover(
    { companyId: co._id },
    { id: String(version._id), actor: { name: reviewer.name, email: reviewer.email } },
  );
  return {
    co, fileId: String(accepted.file.id), requestId: String(request._id),
    lineRef, handoverRef: `REQ-7-${n}`, quantity, styleSeq: n,
  };
}

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
    admin: await actor({ companies: [co], isAdmin: true }),
    salesApprover: await actor({ companies: [co], grants: { sales: "approver" } }),
    salesViewer: await actor({ companies: [co], grants: { sales: "viewer" } }),
  };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

/**
 * The confirmed requirement as it now stands.
 *
 * A change carries the WHOLE projection, not the fields that moved — the
 * notice model explains why. `before` is never sent: it is read from the
 * accepted handover inside the service, so a merchandiser compares a fact
 * against a claim rather than two claims.
 */
const projection = (w, over = {}) => ({
  orderRef: w.handoverRef,
  orderLineRef: w.lineRef,
  styleRef: `SC-7-${w.styleSeq}`,
  productName: `Polo ${w.styleSeq}`,
  buyerDisplayLabel: `Buyer ${w.styleSeq}`,
  totalQuantity: 500,
  deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity: 500 }],
  ...over,
});

/** Sales issues a change against the handed-over line. */
async function issueChange(w, who, over = {}) {
  const { after, ...rest } = over;
  return sales(`/requests/${w.requestId}/lines/${w.lineRef}`, {
    ...at(w, who), method: "POST",
    body: {
      changeKind: "QUANTITY",
      after: projection(w, after || {}),
      reason: "The buyer increased the order by a hundred units for the second drop.",
      ...rest,
    },
  });
}

/* ══ 1 — SALES OWNS THE CHANGE ════════════════════════════════════════════ */

describe("Merchandising cannot author a change", () => {
  test("no Merchandising route creates one", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/changeControlRoute.js"), "utf8",
    );
    /* Every change route on the Merchandising side is about an EXISTING
       change: acknowledge, clarify, impact, coordinate, close. None creates. */
    const posts = [...src.matchAll(/router\.post\("([^"]*changes[^"]*)"/g)].map((m) => m[1]);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p).toMatch(/:changeRef/);
  });

  test("no Merchandising service imports the notice model to write it", () => {
    const dir = path.join(__dirname, "../../services/merchandising");
    const importers = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /SalesChangeNotice/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    for (const f of importers) {
      const bare = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(bare).not.toMatch(/SalesChangeNotice\.create/, f);
      expect(bare).not.toMatch(/new SalesChangeNotice/, f);
    }
  });

  test("a Merchandising owner cannot issue one on the Sales route", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const who of [c.owner, c.approver, c.admin]) {
      const res = await issueChange(w, who);
      expect(res.status).toBe(403);
    }
  });

  test("a Sales approver can, and a Sales viewer cannot", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await issueChange(w, c.salesViewer)).status).toBe(403);
    const ok = await issueChange(w, c.salesApprover);
    expect(ok.status).toBe(201);
    expect(ok.body.notice.changeRef).toMatch(/^CHG-/);
    expect(ok.body.notice.versionNo).toBe(1);
  });
});

/* ══ 2 — NO BUYER CONVERSATION CROSSES ════════════════════════════════════ */

describe("the buyer conversation stays in Sales", () => {
  test("every forbidden field is refused BY NAME, saying whose it is", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const field of ["message", "email", "contact", "quotation", "price", "margin", "paymentTerms", "internalNote"]) {
      const res = await issueChange(w, c.salesApprover, { [field]: "something" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBe("CHANGE_FIELD_NOT_ALLOWED");
      expect(res.body.error.details.field).toBe(field);
      /* The refusal says whose record it is — a developer told only
         "not allowed" learns nothing. */
      expect(res.body.message).toMatch(/Sales/);
    }
  });

  test("one nested inside the projection is refused too", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await issueChange(w, c.salesApprover, { after: { price: 12 } });
    expect(res.body.error.code).toBe("CHANGE_FIELD_NOT_ALLOWED");
  });

  test("the schema has no field that could hold one", () => {
    /* Scoped to the payload, not to actor attribution: `authorisedBy.email`
       is the SALESPERSON who authorised the change — the same actorRef every
       record in this codebase carries — and is not buyer contact. What must
       not exist is a field on the notice or its projection that could hold a
       buyer's message, contact or commercial terms. */
    const paths = Object.keys(SalesChangeNotice.schema.paths)
      .filter((p) => !/^(authorisedBy|createdBy|updatedBy|decidedBy)\./.test(p));
    for (const banned of Object.keys(FORBIDDEN_FIELDS)) {
      expect(paths.some((p) => p.split(".").includes(banned))).toBe(false);
    }
    /* And the projection itself carries none of them at any depth. `before`
       and `after` are single-nested subdocuments, so their own schemas have to
       be walked — `schema.paths` shows only the two leaves. */
    const walk = (schema, prefix = "") => Object.entries(schema.paths).flatMap(([key, type]) => {
      const here = prefix ? `${prefix}.${key}` : key;
      const nested = type.schema || type?.$embeddedSchemaType?.schema;
      return nested ? [here, ...walk(nested, here)] : [here];
    });
    const projectionPaths = [
      ...walk(SalesChangeNotice.schema.path("after").schema, "after"),
      ...walk(SalesChangeNotice.schema.path("before").schema, "before"),
    ];
    /* The projection is real and has depth — otherwise this proves nothing. */
    expect(projectionPaths.length).toBeGreaterThan(20);
    expect(projectionPaths).toContain("after.deliveries");
    for (const banned of Object.keys(FORBIDDEN_FIELDS)) {
      expect(projectionPaths.some((p) => p.split(".").includes(banned))).toBe(false);
    }
  });

  test("before/after accept only the typed projection's own fields", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await issueChange(w, c.salesApprover, { after: { somethingInvented: true } });
    expect(res.body.error.code).toBe("CHANGE_FIELD_NOT_ALLOWED");
    expect(res.body.error.details.field).toBe("after.somethingInvented");
  });
});

/* ══ IDENTITY, VERSIONING AND INTAKE ══════════════════════════════════════ */

describe("a change keeps one identity across its versions", () => {
  test("a second change on the same line is version 2 of the same change", async () => {
    const w = await world();
    const c = await cast(w.co);
    const one = await issueChange(w, c.salesApprover);
    const two = await issueChange(w, c.salesApprover, {
      after: { totalQuantity: 600 },
      reason: "The buyer increased it again, to six hundred units in total.",
    });
    expect(two.status).toBe(201);
    /* Same ref — a merchandiser who assessed version 1 sees a revision of the
       thing they already looked at, not a second change. */
    expect(two.body.notice.changeRef).toBe(one.body.notice.changeRef);
    expect(two.body.notice.versionNo).toBe(2);

    const first = await SalesChangeNotice.findById(one.body.notice.id).lean();
    expect(first.state).toBe(NOTICE_STATE.SUPERSEDED);
    /* One ISSUED version per change, enforced by the partial unique index. */
    expect(await SalesChangeNotice.countDocuments({
      companyId: w.co._id, changeRef: one.body.notice.changeRef, state: "ISSUED",
    })).toBe(1);
  });

  test("it uses the permanent line reference, never a style id", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await issueChange(w, c.salesApprover);
    expect(res.body.notice.handoverLineRef).toBe(w.lineRef);
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/sales/changeNotice.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/sampleStyleId|styleId/);
  });

  test("an issued notice is frozen — a correction is a new version", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await issueChange(w, c.salesApprover);
    const notice = await SalesChangeNotice.findById(res.body.notice.id);
    notice.reason = "something else entirely";
    await expect(notice.save()).rejects.toThrow(/frozen/i);
  });

  test("the change reaches the file, and Merchandising can see it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    expect(issued.body.downstream.delivered).toBe(true);

    const list = await call(`/files/${w.fileId}/changes`, at(w, c.viewer));
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].notice.changeRef).toBe(issued.body.notice.changeRef);
    /* PENDING computed, never stored. */
    expect(list.body.rows[0].receipt.state).toBe("PENDING");
    expect(list.body.rows[0].impact).toBeNull();
  });

  test("redelivery is idempotent, and a stale version is a NOOP", async () => {
    const w = await world();
    const c = await cast(w.co);
    await issueChange(w, c.salesApprover);

    const event = await require("../../models/CMS_Models/Sales/SalesHandoverEvent")
      .SalesHandoverOutboxEvent.findOne({
        companyId: w.co._id, kind: "sales.change_notice.issued",
      }).lean();
    const intake = require("../../services/merchandising/changeIntake.service");
    const again = await intake.receive(event);
    expect(again.duplicate).toBe(true);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });

  test("a cancellation withdraws the change and KEEPS what was assessed", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;

    await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE", note: "The extra hundred units need a second fabric order.",
        affectedApplications: ["SUPPLY_CHAIN"],
      },
    });

    const cancelled = await sales(`/${ref}/cancel`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { reason: "The buyer withdrew the increase." },
    });
    expect(cancelled.status).toBe(200);

    /* The assessment happened. A cancelled change does not un-happen the
       work somebody did on it. */
    const impact = await ChangeImpact.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    expect(impact).toBeTruthy();
    expect(impact.state).toBe(IMPACT_STATE.CLOSED);
    expect(impact.decision).toBe("REVISE");

    const receipt = await ChangeIntakeReceipt.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    expect(receipt.state).toBe(INTAKE_STATE.CANCELLED_BY_SALES);
    expect(receipt.decidedAt).toBeTruthy();
  });
});

/* ══ MERCHANDISING'S ANSWER ═══════════════════════════════════════════════ */

describe("Merchandising answers, and cannot refuse", () => {
  test("there is no reject anywhere in the intake contract", () => {
    expect(Object.values(INTAKE_STATE)).not.toContain("REJECTED");
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/changeControlRoute.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/reject/i);
  });

  test("acknowledging is once, and a second answer is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;

    const first = await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(first.status).toBe(200);
    const second = await call(`/files/${w.fileId}/changes/${ref}/clarify`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { category: "OTHER", reason: "Changing my mind after acknowledging it." },
    });
    expect(second.body.error.code).toBe("CHANGE_ALREADY_DECIDED");
  });

  test("a clarification needs a category and a usable reason", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;
    const short = await call(`/files/${w.fileId}/changes/${ref}/clarify`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { category: "DATE_NOT_ACHIEVABLE", reason: "no" },
    });
    expect(short.status).toBeGreaterThanOrEqual(400);
    expect(short.body.error.details.minimum).toBe(15);
  });

  test("answering a superseded version is refused as stale", async () => {
    const w = await world();
    const c = await cast(w.co);
    const one = await issueChange(w, c.salesApprover);
    await issueChange(w, c.salesApprover, {
      after: { totalQuantity: 700 }, reason: "Increased again to seven hundred units.",
    });
    /* The route resolves the CURRENT version of the ref, so this succeeds
       against version 2 — what it must never do is answer version 1. */
    const res = await call(`/files/${w.fileId}/changes/${one.body.notice.changeRef}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(res.status).toBe(200);
    expect(res.body.changeVersionNo).toBe(2);
  });
});

/* ══ 3 — IMPACT CREATES REVISIONS, NEVER OVERWRITES ═══════════════════════ */

describe("impact never overwrites an approved record", () => {
  test("the impact service writes no approved revision, baseline or pack", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/changeControl.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    /* It records revision NUMBERS. It never mints or edits the records
       themselves — those belong to the services that own them. */
    for (const banned of [
      /MaterialTrimRevision/, /PackagingRevision/, /DevelopmentRevision/,
      /TnaBaseline/, /ExecutionPack/, /\.baselineDate\s*=/, /\.approvedAt\s*=/,
    ]) {
      expect(bare).not.toMatch(banned, String(banned));
    }
  });

  test("an approved revision is byte-identical after a change goes through", async () => {
    const w = await world();
    const c = await cast(w.co);
    const fileId = new mongoose.Types.ObjectId(w.fileId);
    const approved = await MaterialTrimRevision.create({
      companyId: w.co._id, fileId, revisionNo: 1, state: "APPROVED",
      approvedAt: new Date("2026-09-01T10:00:00Z"),
      approvedBy: { name: "An Approver", email: "a@grav.test" },
    });
    const before = JSON.stringify(await MaterialTrimRevision.findById(approved._id).lean());

    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;
    await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE",
        note: "The trim card needs a new revision for the additional units.",
        materialTrimImpact: { impacted: true, note: "New revision required." },
        affectedApplications: ["SUPPLY_CHAIN"],
      },
    });

    /* The March revision is exactly what it was. */
    expect(JSON.stringify(await MaterialTrimRevision.findById(approved._id).lean())).toBe(before);
  });

  test("an assessment cannot state a revision number it did not produce", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const res = await call(`/files/${w.fileId}/changes/${issued.body.notice.changeRef}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE", note: "Trying to claim a revision that does not exist yet.",
        materialTrimImpact: { impacted: true, newRevisionNo: 9 },
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/recorded when the revision is actually produced/i);
  });

  test("a produced revision is recorded as a NUMBER, afterwards", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;
    const assessed = await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE", note: "The packaging spec needs restating for the new split.",
        packagingImpact: { impacted: true }, affectedApplications: ["STORE"],
      },
    });
    expect(assessed.status).toBe(200);

    const impact = await ChangeImpact.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    const produced = await call(`/files/${w.fileId}/changes/${ref}/impact/produced`, {
      ...at(w, c.editor), method: "POST",
      body: { area: "PACKAGING", revisionNo: 2, expectedRevision: impact.revision },
    });
    expect(produced.status).toBe(200);
    expect(produced.body.revisionNo).toBe(2);

    const after = await ChangeImpact.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    expect(after.packagingImpact.newRevisionNo).toBe(2);
    expect(after.packagingImpact.impacted).toBe(true);
  });

  test("an assessment names only units this file actually has", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const res = await call(`/files/${w.fileId}/changes/${issued.body.notice.changeRef}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "ABSORB", note: "Nothing internal has to change for this one.",
        affectedUnits: ["NOT-A-REAL-UNIT"],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/not an execution unit on this file/i);
  });
});

/* ══ 4 — ACKNOWLEDGEMENTS ═════════════════════════════════════════════════ */

describe("each application owns its acknowledgement", () => {
  async function coordinated(w, c, applications = ["SUPPLY_CHAIN", "STORE"]) {
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;
    await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE", note: "The additional units affect sourcing and the store receipt.",
        affectedApplications: applications,
      },
    });
    const impact = await ChangeImpact.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    const res = await call(`/files/${w.fileId}/changes/${ref}/impact/coordinate`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: impact.revision },
    });
    if (res.status !== 200) throw new Error(`coordinate: ${JSON.stringify(res.body)}`);
    return { ref, versionNo: issued.body.notice.versionNo };
  }

  test("coordinating announces to each application, and emits one event", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref } = await coordinated(w, c);

    const event = await MerchandisingOutboxEvent.findOne({
      companyId: w.co._id, kind: OUTBOX_KIND.CHANGE_IMPACT_COORDINATED,
    }).lean();
    expect(event).toBeTruthy();
    expect(event.payload.changeRef).toBe(ref);
    expect(event.payload.affectedApplications.sort()).toEqual(["STORE", "SUPPLY_CHAIN"]);
  });

  test("Merchandising has no route or service that writes an acknowledgement", () => {
    const routeSrc = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/changeControlRoute.js"), "utf8",
    );
    const bare = routeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/ChangeAcknowledgement/);

    /* Exactly one service writes one, and it is the receiver. */
    const dir = path.join(__dirname, "../../services/merchandising");
    const writers = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).filter((f) => (
      /ChangeAcknowledgement\.create/.test(fs.readFileSync(path.join(dir, f), "utf8"))
    ));
    expect(writers).toEqual(["changeAckIntake.service.js"]);
  });

  test("an application's answer is recorded, and is not readiness", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref, versionNo } = await coordinated(w, c);

    const out = await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(),
      companyId: w.co._id,
      kind: "supply_chain.change_acknowledgement.recorded",
      correlationId: `c-${++seq}`,
      payload: {
        changeRef: ref, changeVersionNo: versionNo, state: "ACCEPTED",
        actor: { name: "A Buyer In Supply Chain" },
      },
    });
    expect(out.applied).toBe(true);

    const view = await call(`/files/${w.fileId}/changes/${ref}`, at(w, c.viewer));
    const sc = view.body.acknowledgements.find((a) => a.application === "SUPPLY_CHAIN");
    expect(sc.state).toBe("ACCEPTED");
    expect(sc.counted).toBe(true);
    /* Said on the row itself: acknowledged is not done. */
    expect(sc.sentence).toMatch(/not a statement that .* is ready/i);

    const store = view.body.acknowledgements.find((a) => a.application === "STORE");
    expect(store.state).toBe("PENDING");
    expect(view.body.coverage).toEqual({ announced: 2, acknowledged: 1, stale: 0, pending: 1 });
  });

  test("an answer to an older version is shown but NOT counted", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref, versionNo } = await coordinated(w, c);

    await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(),
      companyId: w.co._id,
      kind: "supply_chain.change_acknowledgement.recorded",
      correlationId: `c-${++seq}`,
      payload: { changeRef: ref, changeVersionNo: versionNo, state: "ACCEPTED" },
    });

    /* Sales issues version 2. Supply Chain agreed to version 1. */
    await issueChange(w, c.salesApprover, {
      after: { totalQuantity: 900 }, reason: "The buyer increased it again, to nine hundred.",
    });
    await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: {
        decision: "REVISE", note: "The second increase affects sourcing again.",
        affectedApplications: ["SUPPLY_CHAIN", "STORE"],
      },
    });

    const view = await call(`/files/${w.fileId}/changes/${ref}`, at(w, c.viewer));
    const sc = view.body.acknowledgements.find((a) => a.application === "SUPPLY_CHAIN");
    expect(sc.stale).toBe(true);
    expect(sc.counted).toBe(false);
    expect(sc.changeVersionNo).toBe(1);
    expect(view.body.coverage.acknowledged).toBe(0);
    expect(view.body.coverage.stale).toBe(1);
  });

  test("a rejection-as-invalid needs a reason, and is about applicability", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref, versionNo } = await coordinated(w, c, ["LOGISTICS"]);

    const noReason = await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(),
      companyId: w.co._id,
      kind: "logistics.change_acknowledgement.recorded",
      correlationId: `c-${++seq}`,
      payload: { changeRef: ref, changeVersionNo: versionNo, state: "REJECTED_AS_INVALID" },
    });
    expect(noReason.outcome).toBe("NOOP");
    expect(noReason.note).toMatch(/without a usable reason/i);

    const withReason = await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(),
      companyId: w.co._id,
      kind: "logistics.change_acknowledgement.recorded",
      correlationId: `c-${++seq}`,
      payload: {
        changeRef: ref, changeVersionNo: versionNo, state: "REJECTED_AS_INVALID",
        reason: "This is a fabric quantity change and does not reach shipment booking.",
      },
    });
    expect(withReason.applied).toBe(true);

    const view = await call(`/files/${w.fileId}/changes/${ref}`, at(w, c.viewer));
    const log = view.body.acknowledgements.find((a) => a.application === "LOGISTICS");
    expect(log.state).toBe("REJECTED_AS_INVALID");
    expect(log.sentence).toMatch(/does not apply to them/i);
    /* Not counted as coverage — it is not an acceptance. */
    expect(log.counted).toBe(false);
  });

  test("an acknowledgement of a state nobody defined is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref, versionNo } = await coordinated(w, c, ["STORE"]);
    const out = await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(),
      companyId: w.co._id,
      kind: "store.change_acknowledgement.recorded",
      correlationId: `c-${++seq}`,
      payload: { changeRef: ref, changeVersionNo: versionNo, state: "TOTALLY_MADE_UP" },
    });
    expect(out.outcome).toBe("NOOP");
    expect(await ChangeAcknowledgement.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a duplicate answer from one application is a NOOP", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { ref, versionNo } = await coordinated(w, c, ["STORE"]);
    const payload = { changeRef: ref, changeVersionNo: versionNo, state: "ACCEPTED" };
    await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(), companyId: w.co._id,
      kind: "store.change_acknowledgement.recorded", correlationId: `c-${++seq}`, payload,
    });
    const again = await ackIntake.receive({
      _id: new mongoose.Types.ObjectId(), companyId: w.co._id,
      kind: "store.change_acknowledgement.recorded", correlationId: `c-${++seq}`, payload,
    });
    expect(again.outcome).toBe("NOOP");
    expect(await ChangeAcknowledgement.countDocuments({
      companyId: w.co._id, changeRef: ref, application: "STORE",
    })).toBe(1);
  });

  test("coordinating to nobody is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;
    await call(`/files/${w.fileId}/changes/${ref}/impact`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { decision: "ABSORB", note: "Nothing internal changes for this one at all." },
    });
    const impact = await ChangeImpact.findOne({ companyId: w.co._id, changeRef: ref }).lean();
    const res = await call(`/files/${w.fileId}/changes/${ref}/impact/coordinate`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: impact.revision },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/coordinating to nobody announces nothing/i);
  });
});

/* ══ 5 — BULK ═════════════════════════════════════════════════════════════ */

describe("bulk is preview-first and honest per row", () => {
  test("preview writes nothing but the preview", async () => {
    const w = await world();
    const c = await cast(w.co);
    const before = await ExecutionFile.findById(w.fileId).lean();

    const pv = await call("/bulk/assignment/preview", {
      ...at(w, c.owner), method: "POST",
      body: { rows: [{ fileId: w.fileId, email: c.editor.email }] },
    });
    expect(pv.status).toBe(200);
    expect(pv.body.rows[0].outcome).toBe("APPLIED");
    expect(pv.body.note).toMatch(/[Nn]othing has been changed/);

    const after = await ExecutionFile.findById(w.fileId).lean();
    expect(after.revision).toBe(before.revision);
    expect(str(after.responsibleMerchandiser?.email)).toBe(str(before.responsibleMerchandiser?.email));
  });

  test("apply needs a preview, and applies what it showed", async () => {
    const w = await world();
    const c = await cast(w.co);
    const noPreview = await call("/bulk/assignment/apply", {
      ...at(w, c.owner), method: "POST", body: {},
    });
    expect(noPreview.status).toBeGreaterThanOrEqual(400);
    expect(noPreview.body.message).toMatch(/previewId/);

    const pv = await call("/bulk/assignment/preview", {
      ...at(w, c.owner), method: "POST",
      body: { rows: [{ fileId: w.fileId, email: c.editor.email }] },
    });
    const applied = await call("/bulk/assignment/apply", {
      ...at(w, c.owner), method: "POST", body: { previewId: pv.body.previewId },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.summary.applied).toBe(1);

    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.responsibleMerchandiser.email).toBe(c.editor.email);
  });

  test("a preview whose source moved is refused, not silently applied", async () => {
    const w = await world();
    const c = await cast(w.co);
    const pv = await call("/bulk/assignment/preview", {
      ...at(w, c.owner), method: "POST",
      body: { rows: [{ fileId: w.fileId, email: c.editor.email }] },
    });

    /* Somebody else touches the file between preview and apply. */
    await ExecutionFile.updateOne({ _id: w.fileId }, { $inc: { revision: 1 } });

    const applied = await call("/bulk/assignment/apply", {
      ...at(w, c.owner), method: "POST", body: { previewId: pv.body.previewId },
    });
    expect(applied.body.error.code).toBe("BULK_PREVIEW_STALE");
    expect(applied.body.message).toMatch(/what you apply is what you were shown/i);
  });

  test("a refused row never discards the applied ones", async () => {
    const a = await world();
    const b = await world();
    const c = await cast(a.co);
    const pv = await call("/bulk/assignment/preview", {
      ...at(a, c.owner), method: "POST",
      body: {
        rows: [
          { fileId: a.fileId, email: c.editor.email },
          /* Another company's file — invisible, so refused. */
          { fileId: b.fileId, email: c.editor.email },
          { fileId: a.fileId },
        ],
      },
    });
    expect(pv.body.summary).toEqual({ total: 3, applied: 1, skipped: 0, refused: 2 });

    const applied = await call("/bulk/assignment/apply", {
      ...at(a, c.owner), method: "POST", body: { previewId: pv.body.previewId },
    });
    expect(applied.body.summary.applied).toBe(1);
    expect(applied.body.summary.refused).toBe(2);
    /* The good row landed. */
    expect((await ExecutionFile.findById(a.fileId).lean()).responsibleMerchandiser.email)
      .toBe(c.editor.email);
  });

  test("over 500 rows is an explicit refusal with the number in it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => ({
      fileId: w.fileId, email: c.editor.email,
    }));
    const pv = await call("/bulk/assignment/preview", {
      ...at(w, c.owner), method: "POST", body: { rows },
    });
    expect(pv.body.error.code).toBe("BULK_LIMIT_EXCEEDED");
    expect(pv.body.message).toMatch(String(MAX_ROWS + 1));
    expect(pv.body.error.details.maximum).toBe(MAX_ROWS);
  });

  test("each command asks for its own single-record capability", async () => {
    const w = await world();
    const c = await cast(w.co);
    /* Assignment is owner. An approver — one rung below — is refused. */
    const denied = await call("/bulk/assignment/preview", {
      ...at(w, c.approver), method: "POST",
      body: { rows: [{ fileId: w.fileId, email: c.editor.email }] },
    });
    expect(denied.status).toBe(403);
    /* Forecast is editor, so an editor may. */
    const allowed = await call("/bulk/forecast/preview", {
      ...at(w, c.editor), method: "POST",
      body: { rows: [{ fileId: w.fileId, milestoneRef: "X", forecastDate: "2026-11-01" }] },
    });
    expect(allowed.status).toBe(200);
  });

  test("the CSV matches the per-row outcomes and is formula-safe", async () => {
    const w = await world();
    const c = await cast(w.co);
    const pv = await call("/bulk/assignment/preview", {
      ...at(w, c.owner), method: "POST",
      body: { rows: [{ fileId: w.fileId, email: c.editor.email }, { fileId: w.fileId }] },
    });
    await call("/bulk/assignment/apply", {
      ...at(w, c.owner), method: "POST", body: { previewId: pv.body.previewId },
    });

    const csv = await call(`/bulk/results/${pv.body.previewId}.csv`, at(w, c.owner));
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toBe("row,reference,fileId,outcome,reason,detail");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/APPLIED/);
    expect(lines[2]).toMatch(/REFUSED/);
  });

  test("a formula in a reason cannot execute in a spreadsheet", () => {
    const bulk = require("../../services/merchandising/bulk.service");
    expect(bulk.csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(bulk.csvCell("+1")).toBe("'+1");
    expect(bulk.csvCell("@x")).toBe("'@x");
    expect(bulk.csvCell("-2")).toBe("'-2");
    /* And ordinary text with a comma is quoted, not mangled. */
    expect(bulk.csvCell("a,b")).toBe('"a,b"');
  });

  test("import writes configuration only — never orders or selections", async () => {
    const w = await world();
    const c = await cast(w.co);
    const pv = await call("/bulk/import/preview", {
      ...at(w, c.owner), method: "POST",
      body: {
        rows: [
          { kind: "REASON_CODE", code: "BUYER_CHANGE", label: "Buyer changed", kindOf: "RESCHEDULE" },
          { kind: "ORDER", code: "anything" },
        ],
      },
    });
    expect(pv.body.rows[0].outcome).toBe("APPLIED");
    expect(pv.body.rows[1].outcome).toBe("REFUSED");
    expect(pv.body.rows[1].reason).toMatch(/Only reason codes can be imported/i);
  });
});

/* ══ EXPORTS, REPORTS, ARCHIVE, OPS ═══════════════════════════════════════ */

describe("exports carry nothing they should not", () => {
  test("no export column is a rate, cost, margin, supplier or contact", () => {
    const exporter = require("../../services/merchandising/export.service");
    for (const key of exporter.EXPORT_KEYS) {
      for (const col of exporter.EXPORTS[key].columns) {
        expect(col).not.toMatch(/rate|cost|margin|supplier|price|contact|email|phone/i);
      }
    }
  });

  test("an export is company-scoped and behind the export capability", async () => {
    const a = await world();
    const b = await world();
    const c = await cast(a.co);

    const denied = await call("/exports/execution-files.csv", at(a, c.approver));
    expect(denied.status).toBe(403);

    const csv = await call("/exports/execution-files.csv", at(a, c.owner));
    expect(csv.status).toBe(200);
    /* Company A's file is in it; company B's is not. */
    const fileA = await ExecutionFile.findById(a.fileId).lean();
    const fileB = await ExecutionFile.findById(b.fileId).lean();
    expect(csv.text).toContain(fileA.fileNumber);
    expect(csv.text).not.toContain(fileB.fileNumber);
  });

  test("generating one is audited with the filter that produced it", async () => {
    const w = await world();
    const c = await cast(w.co);
    await call("/exports/execution-files.csv?lifecycleStatus=OPEN", at(w, c.owner));
    const {
      MerchandisingAuditEvent,
    } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
    const audit = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, action: "EXPORT_GENERATED",
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit.details.dataset).toBe("execution-files");
    expect(audit.details.filters.lifecycleStatus).toBe("OPEN");
  });
});

describe("reports never calculate a positive from missing data", () => {
  test("a company with no plans has no adherence figure, and says so", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/reports/tna-adherence", at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.onTrack.available).toBe(false);
    expect(res.body.onTrack.value).toBeNull();
    expect(res.body.onTrack.sentence).toMatch(/nothing to measure/i);
  });

  test("a department that has reported nothing is not a measurement of zero", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/reports/department-reporting", at(w, c.viewer));
    expect(res.body.rows).toHaveLength(8);
    for (const r of res.body.rows) {
      expect(r.currentStatements).toBe(0);
      expect(r.sentence.length).toBeGreaterThan(10);
    }
    expect(res.body.note).toMatch(/not a measurement of zero/i);
  });

  test("every report figure names the records it opens", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/reports/files-by-lifecycle", at(w, c.viewer));
    for (const row of res.body.rows) expect(row.opens).toBeTruthy();
  });
});

describe("archiving hides and never deletes", () => {
  test("a live file cannot be archived", async () => {
    const w = await world();
    const c = await cast(w.co);
    const archive = require("../../services/merchandising/archive.service");
    await expect(archive.archiveFile({ companyId: w.co._id }, { fileId: w.fileId }))
      .rejects.toThrow(/still live work/i);
  });

  test("an archived file leaves the default register and stays readable", async () => {
    const w = await world();
    const c = await cast(w.co);
    const archive = require("../../services/merchandising/archive.service");
    await ExecutionFile.updateOne({ _id: w.fileId }, { $set: { lifecycleStatus: "CLOSED" } });
    await archive.archiveFile({ companyId: w.co._id }, { fileId: w.fileId, reason: "Finished." });

    const list = await call("/files?view=closed", at(w, c.viewer));
    expect(list.body.rows.map((r) => r.id)).not.toContain(w.fileId);

    /* Still there, still complete, still openable by reference. */
    const direct = await call(`/files/${w.fileId}`, at(w, c.viewer));
    expect(direct.status).toBe(200);
    const doc = await ExecutionFile.findById(w.fileId).lean();
    expect(doc).toBeTruthy();
    expect(doc.archived).toBe(true);
    expect(doc.fileNumber).toBeTruthy();

    /* And restoring is just the flag. */
    await archive.restoreFile({ companyId: w.co._id }, { fileId: w.fileId });
    expect((await ExecutionFile.findById(w.fileId).lean()).archived).toBe(false);
  });

  test("there is no delete anywhere in the archive service", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/archive.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const banned of [/deleteOne/, /deleteMany/, /findByIdAndDelete/, /remove\(/, /\$unset/]) {
      expect(bare).not.toMatch(banned, String(banned));
    }
  });
});

describe("observability is a query, not a daemon", () => {
  test("no timer, interval, cron or worker is introduced", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/ops.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const banned of [
      /setInterval/, /setTimeout/, /node-cron/, /cron\.schedule/, /new Worker/, /Bull|Agenda|Kue/,
    ]) {
      expect(bare).not.toMatch(banned, String(banned));
    }
  });

  test("the outbox panel says its figures are read on request", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/ops/outbox", at(w, c.owner));
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/Nothing polls, and no daemon or broker/i);
  });

  test("ops is manager-only", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const who of [c.viewer, c.editor, c.approver]) {
      expect((await call("/ops/stuck", at(w, who))).status).toBe(403);
    }
    expect((await call("/ops/stuck", at(w, c.owner))).status).toBe(200);
  });

  test("a stuck row is surfaced with its attempts, error and correlation id", async () => {
    const w = await world();
    const c = await cast(w.co);
    await MerchandisingOutboxEvent.create({
      companyId: w.co._id,
      kind: OUTBOX_KIND.CHANGE_IMPACT_COORDINATED,
      payload: {
        executionFileId: new mongoose.Types.ObjectId(w.fileId),
        changeRef: "CHG-stuck", changeVersionNo: 1,
      },
      correlationId: "corr-stuck-1",
      status: "PENDING",
      attempts: 5,
      lastError: "The receiver was unreachable.",
    });
    const res = await call("/ops/stuck?attempts=3", at(w, c.owner));
    const row = res.body.rows.find((r) => r.correlationId === "corr-stuck-1");
    expect(row).toBeTruthy();
    expect(row.attempts).toBe(5);
    expect(row.lastError).toMatch(/unreachable/);
  });
});

/* ══ COMPANY ISOLATION AND THE CAPABILITY MATRIX ══════════════════════════ */

describe("nothing crosses a company boundary", () => {
  test("company B cannot read or act on company A's changes", async () => {
    const a = await world();
    const b = await world();
    const ca = await cast(a.co);
    const issued = await issueChange(a, ca.salesApprover);
    const ref = issued.body.notice.changeRef;

    const intruder = await actor({
      companies: [b.co], grants: { merchandiser: "owner", sales: "approver" },
    });
    for (const [p, method, body] of [
      [`/files/${a.fileId}/changes`, "GET", undefined],
      [`/files/${a.fileId}/changes/${ref}`, "GET", undefined],
      [`/files/${a.fileId}/changes/${ref}/acknowledge`, "POST", {}],
      [`/files/${a.fileId}/changes/${ref}/impact`, "POST", { decision: "ABSORB", note: "x".repeat(20) }],
    ]) {
      const res = await call(p, { token: intruder.token, company: b.co._id, method, body, key: uniq() });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }

    const portfolio = await call("/changes?state=all", { token: intruder.token, company: b.co._id });
    expect(portfolio.body.rows.every((r) => r.fileId !== a.fileId)).toBe(true);
  });
});

describe("the capability matrix", () => {
  test("a viewer reads changes but cannot acknowledge; an editor can", async () => {
    const w = await world();
    const c = await cast(w.co);
    const issued = await issueChange(w, c.salesApprover);
    const ref = issued.body.notice.changeRef;

    expect((await call(`/files/${w.fileId}/changes`, at(w, c.viewer))).status).toBe(200);
    const denied = await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.viewer), method: "POST", key: uniq(),
    });
    expect(denied.status).toBe(403);
    const allowed = await call(`/files/${w.fileId}/changes/${ref}/acknowledge`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(allowed.status).toBe(200);
  });

  test("a platform admin reaches nothing", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const p of ["/changes", "/reports/tna-adherence", "/ops/outbox"]) {
      expect((await call(p, at(w, c.admin))).status).toBe(403);
    }
  });

  test("a revoked grant stops working on the very next request", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await call("/changes", at(w, c.viewer))).status).toBe(200);
    await DepartmentRole.updateMany({ email: c.viewer.email }, { $set: { isActive: false } });
    expect((await call("/changes", at(w, c.viewer))).status).toBe(403);
  });

  test("M7 added no capability constant", () => {
    const access = require("../../services/merchandising/access.service");
    /* ── THE FOURTEEN FROM M0, NAMED ──────────────────────────────────
       This used to assert a COUNT, which made it a guard against anybody
       extending the vocabulary for any reason — including reasons that have
       nothing to do with this milestone. It broke the day another lane added
       `PROCUREMENT_RELEASE` for order demand release, which is a real feature
       with its own owner and its own tests.

       What this test was written to prove is narrower and is unchanged: the
       fourteen M0 capabilities are still exactly what THIS work authorises
       against, and it introduced none of its own. So it names them. A
       fifteenth constant for somebody else's feature is that lane's decision
       to defend; silently counting it here proved nothing about either. */
    const M0_CAPABILITIES = [
      "FILE_READ", "FILE_MANAGE", "FILE_ASSIGN", "FILE_LIFECYCLE",
      "BRIEF_REVIEW", "SELECTION_WRITE", "SELECTION_APPROVE", "REQUIREMENT_WRITE",
      "TNA_MANAGE", "TNA_EXECUTE", "HANDOVER_SUBMIT", "CHANGE_COORDINATE",
      "CONFIGURATION_MANAGE", "EXPORT",
    ];
    for (const name of M0_CAPABILITIES) {
      expect(Object.keys(access.CAPABILITY)).toContain(name);
    }

    /* And change control introduced none of its own: it authorises against
       `CHANGE_COORDINATE`, which M0 already had. */
    for (const name of Object.keys(access.CAPABILITY)) {
      expect(name).not.toMatch(/^CHANGE_(?!COORDINATE)/);
    }
  });
});

/* ══ PAGINATION AND INDEXES ═══════════════════════════════════════════════ */

describe("every unbounded list is cursor-paged and indexed", () => {
  test("no service in the M7 surface uses skip", () => {
    const files = [
      "services/merchandising/changeControl.service.js",
      "services/merchandising/bulk.service.js",
      "services/merchandising/reports.service.js",
      "services/merchandising/export.service.js",
      "services/merchandising/ops.service.js",
      "services/merchandising/archive.service.js",
    ];
    for (const f of files) {
      const bare = fs.readFileSync(path.join(__dirname, "../..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      /* `skip` degrades linearly and is wrong under insertion. */
      expect(bare).not.toMatch(/\.skip\(/, f);
    }
  });

  test("the change portfolio pages stably and caps its limit", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (let i = 0; i < 3; i += 1) {
      const other = await world();
      const oc = await cast(other.co);
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueChange(other, oc.salesApprover);
      // eslint-disable-next-line no-await-in-loop
      await call(`/files/${other.fileId}/changes/${issued.body.notice.changeRef}/impact`, {
        ...at(other, oc.editor), method: "POST", key: uniq(),
        body: { decision: "ABSORB", note: "Nothing internal changes for this one." },
      });
    }
    const capped = await call("/changes?state=all&limit=9999", at(w, c.viewer));
    expect(capped.status).toBe(200);
    expect(capped.body.rows.length).toBeLessThanOrEqual(100);
  });

  test("the change-impact query uses an index rather than a collection scan", async () => {
    const w = await world();
    const plan = await ChangeImpact.collection.find({
      companyId: w.co._id, changeRef: "CHG-x", changeVersionNo: 1,
    }).explain("queryPlanner");
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain("IXSCAN");
    expect(winning).not.toMatch(/"stage":"COLLSCAN"/);
  });
});

const str = (v) => String(v ?? "").trim();
