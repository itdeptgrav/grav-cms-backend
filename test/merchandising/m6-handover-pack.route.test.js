// test/merchandising/m6-handover-pack.route.test.js
//
// M6 — DEPARTMENT STATUS, THE EXECUTION PACK, AND THE PPC HANDOVER.
//
// Four claims, and they are the milestone:
//
//   1  MERCHANDISING NEVER MARKS ANOTHER DEPARTMENT READY. No route, no
//      service export and no model path writes a projection. The absence is
//      the guarantee, so a source scan asserts it.
//
//   2  NO GATE IS ANOTHER DEPARTMENT'S READINESS. A pack submits successfully
//      with every department UNKNOWN. Gating on Store stock or PPC capacity
//      would make Merchandising the judge of their work.
//
//   3  A SUBMITTED PACK IS FROZEN. Contents, completeness and declaration
//      cannot change afterwards; a change is a new version and the old one is
//      kept and stays readable.
//
//   4  PPC OWNS THE RECEIVING DECISION. Merchandising cannot write the
//      receipt; a Merchandising grant of any level is refused on PPC's route;
//      acceptance is what makes the file HANDED_OVER, and there is no REJECT.
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
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const { ExecutionPack, PACK_STATE, GATE } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  DownstreamHandoverReceipt, RECEIPT_STATE,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");
const statusIntake = require("../../services/merchandising/departmentStatusIntake.service");
const packDelivery = require("../../services/integration/executionPackDelivery.service");

let server, base, ppcBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "m6_handover" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/handoverPackRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/inboundPacksRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  ppcBase = `http://127.0.0.1:${server.address().port}/api/cms/ppc`;
  /* The partial unique indexes ARE the invariants under test. */
  await ExecutionPack.syncIndexes();
  await DepartmentStatusProjection.syncIndexes();
  await DownstreamHandoverReceipt.syncIndexes();
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
    return { status: r.status, body: parsed };
  });

const call = (p, opts) => req(base)(p, opts);
const ppc = (p, opts) => req(ppcBase)(p, opts);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `m6-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `Six${n}`, email, biometricId: `M6${n}`,
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

/** A company with a real Execution File, which is the only way one exists. */
async function world({ quantity = 400 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `M6 ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Acct ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-6-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-6-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-6-${n}`, styleCode: `SC-6-${n}`, productName: `Polo ${n}`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    materials: { status: "selected", rawItems: [] },
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-6-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
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
  return { co, fileId: String(accepted.file.id), version, quantity };
}

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
    admin: await actor({ companies: [co], isAdmin: true }),
    sales: await actor({ companies: [co], grants: { sales: "owner" } }),
    /* PPC's own people — a separate department grant entirely. */
    ppcViewer: await actor({ companies: [co], grants: { ppc: "viewer" } }),
    ppcApprover: await actor({ companies: [co], grants: { ppc: "approver" } }),
  };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

/**
 * Make every Merchandising-owned gate pass, WITHOUT touching any department's
 * status — which is the point: the pack becomes submittable while every
 * source department has said nothing at all.
 */
async function makeSubmittable(w) {
  const fileId = new mongoose.Types.ObjectId(w.fileId);
  const approved = (extra = {}) => ({
    companyId: w.co._id, fileId, revisionNo: 1, state: "APPROVED",
    approvedAt: new Date("2026-09-01T10:00:00Z"),
    approvedBy: { name: "An Approver", email: "a@grav.test" },
    ...extra,
  });
  await MaterialTrimRevision.create(approved());
  await PackagingRevision.create(approved());
  await DevelopmentRevision.create(approved());

  /* An approved T&A baseline. Created directly: M5's own suite proves the
     path that produces one, and repeating it here would test M5 twice. */
  const { TnaPlan, TnaBaseline } = require("../../models/CMS_Models/Merchandising/TnaPlan");
  const [plan] = await TnaPlan.create([{
    companyId: w.co._id, fileId, templateId: new mongoose.Types.ObjectId(),
    templateVersionId: new mongoose.Types.ObjectId(), templateVersionNo: 1,
    templateName: "Standard", calendarId: new mongoose.Types.ObjectId(),
    calendarVersionId: new mongoose.Types.ObjectId(), calendarVersionNo: 1,
    calendarName: "Cal", timezone: "Asia/Kolkata", state: "BASELINED",
    planStartDate: "2026-09-07", currentBaselineNo: 1,
  }]);
  await TnaBaseline.create({
    companyId: w.co._id, planId: plan._id, fileId, baselineNo: 1, state: "ACTIVE",
    templateVersionId: plan.templateVersionId, calendarVersionId: plan.calendarVersionId,
    planStartDate: "2026-09-07",
    entries: [{ milestoneRef: "A", milestoneCode: "A", baselineDate: "2026-10-01" }],
    approvedAt: new Date("2026-09-02T10:00:00Z"),
  });
}

/**
 * A department's own event, as its application would hand one over.
 *
 * A PLAIN OBJECT, deliberately — these events belong to Store, Quality and the
 * rest, and live in their stores. Merchandising's outbox is for what
 * Merchandising announces; persisting another app's event into it would be
 * Merchandising publishing on their behalf.
 */
const deptEvent = (w, over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  companyId: w.co._id,
  kind: "store.material.status_changed",
  createdAt: new Date(),
  payload: {
    executionFileId: new mongoose.Types.ObjectId(w.fileId),
    statusCode: "RECEIVED",
    statusLabel: "All material received",
    sourceApp: "store",
    sourceRecordType: "GRN",
    sourceRecordRef: `GRN-${++seq}`,
    sourceRecordVersion: 1,
    sourceObservedAt: new Date("2026-09-05T09:00:00Z"),
    ...over,
  },
  correlationId: `c-${++seq}`,
});

/* ══ 1 — MERCHANDISING NEVER MARKS ANOTHER DEPARTMENT READY ═══════════════ */

describe("no Merchandising path authors a department's status", () => {
  test("the pack router exposes no write route for one", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/handoverPackRoute.js"), "utf8",
    );
    /* Every department-status route is a GET. */
    const statusRoutes = [...src.matchAll(/router\.(get|post|patch|put|delete)\("([^"]*department-status[^"]*)"/g)];
    expect(statusRoutes.length).toBeGreaterThan(0);
    for (const [, verb] of statusRoutes) expect(verb).toBe("get");
  });

  test("the read service exports nothing that could write one", () => {
    const svc = require("../../services/merchandising/departmentStatus.service");
    for (const name of Object.keys(svc)) {
      expect(name).not.toMatch(/set|write|update|record|mark|author|declare|ready/i);
    }
  });

  test("the projection model has no Merchandising actor field", () => {
    /* A name against another department's statement would be a signature on a
       sentence that person never said. */
    const paths = Object.keys(DepartmentStatusProjection.schema.paths);
    for (const p of paths) {
      expect(p).not.toMatch(/^updatedBy|^createdBy|^actor|^decidedBy/);
    }
  });

  test("no route anywhere accepts a department status body", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/department-status`, {
      ...at(w, c.owner), method: "POST",
      body: { department: "STORE", statusCode: "RECEIVED" },
    });
    expect([404, 405]).toContain(res.status);
  });
});

/* ══ DEPARTMENT STATUS — THE FOUR HONEST ANSWERS ══════════════════════════ */

describe("all eight departments always render, and silence is stated", () => {
  test("a file nobody has reported on returns eight rows, none of them blank", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/department-status`, at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(8);

    for (const row of res.body.rows) {
      /* Never a blank, a zero or a tick. */
      expect(row.sentence.length).toBeGreaterThan(10);
      expect(row.statusCode).toBeNull();
      expect(["UNKNOWN", "UNAVAILABLE"]).toContain(row.availability);
      /* And every row attributes itself to its owner. */
      expect(row.attribution).toMatch(/^as reported by /);
    }
  });

  test("the payload itself says this is context, not a gate", async () => {
    /* Carried in the API, not only in the UI, so a second client cannot
       render this register as a completion checklist. */
    const w = await world();
    const c = await cast(w.co);
    const res = await call(`/files/${w.fileId}/department-status`, at(w, c.viewer));
    expect(res.body.disclaimer).toMatch(/context, not a Merchandising submission gate/i);
  });

  test("a reported status shows with its source, version and freshness", async () => {
    const w = await world();
    const c = await cast(w.co);
    const event = deptEvent(w);
    const applied = await statusIntake.receive(event);
    expect(applied.applied).toBe(true);

    const res = await call(`/files/${w.fileId}/department-status`, at(w, c.viewer));
    const store = res.body.rows.find((r) => r.department === "STORE");
    expect(store.availability).toBe("AVAILABLE");
    expect(store.statusCode).toBe("RECEIVED");
    expect(store.sourceRecordRef).toMatch(/^GRN-/);
    expect(store.sourceRecordVersion).toBe(1);
    expect(["FRESH", "AGEING", "STALE"]).toContain(store.freshness);
    expect(store.attribution).toBe("as reported by Store");
  });

  test("freshness lands on the right side of each boundary", () => {
    const contract = require("../../services/merchandising/departmentStatus.contract");
    const now = new Date("2026-09-20T12:00:00Z");
    const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
    expect(contract.freshnessOf(daysAgo(0), now)).toBe("FRESH");
    expect(contract.freshnessOf(daysAgo(3), now)).toBe("FRESH");
    expect(contract.freshnessOf(daysAgo(4), now)).toBe("AGEING");
    expect(contract.freshnessOf(daysAgo(14), now)).toBe("AGEING");
    expect(contract.freshnessOf(daysAgo(15), now)).toBe("STALE");
  });

  test("a stale status still shows the source's status, not a reversion", async () => {
    /* Merchandising does not expire another department's fact. */
    const w = await world();
    const c = await cast(w.co);
    const event = deptEvent(w, { sourceObservedAt: new Date("2020-01-01T00:00:00Z") });
    await statusIntake.receive(event);
    const res = await call(`/files/${w.fileId}/department-status`, at(w, c.viewer));
    const store = res.body.rows.find((r) => r.department === "STORE");
    expect(store.freshness).toBe("STALE");
    expect(store.statusCode).toBe("RECEIVED");
    expect(store.availability).toBe("AVAILABLE");
  });
});

describe("the allowlist refuses rather than stores", () => {
  test("a status outside the department's list is a NOOP with the reason", async () => {
    const w = await world();
    const event = deptEvent(w, { statusCode: "TOTALLY_MADE_UP" });
    const out = await statusIntake.receive(event);
    expect(out.applied).toBe(false);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/is not a status Store may report/i);
    expect(await DepartmentStatusProjection.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a status belonging to a DIFFERENT department is refused too", async () => {
    /* `RELEASED_TO_PRODUCTION` is PPC's word. Store may not use it. */
    const w = await world();
    const event = deptEvent(w, { statusCode: "RELEASED_TO_PRODUCTION" });
    const out = await statusIntake.receive(event);
    expect(out.outcome).toBe("NOOP");
    expect(await DepartmentStatusProjection.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

describe("source events are idempotent and never move backwards", () => {
  test("redelivering finds the ledger row and writes nothing twice", async () => {
    const w = await world();
    const event = deptEvent(w);
    await statusIntake.receive(event);
    const again = await statusIntake.receive(event);
    expect(again.duplicate).toBe(true);
    expect(await DepartmentStatusProjection.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });

  test("two concurrent deliveries: one applies, one reports the duplicate", async () => {
    const w = await world();
    const event = deptEvent(w);
    const [a, b] = await Promise.all([
      statusIntake.receive(event),
      statusIntake.receive(event),
    ]);
    expect([a, b].filter((r) => r.applied)).toHaveLength(1);
    expect([a, b].filter((r) => r.duplicate)).toHaveLength(1);
  });

  test("an older observation does not overwrite a newer one", async () => {
    const w = await world();
    const ref = `GRN-fixed-${++seq}`;
    await statusIntake.receive(deptEvent(w, {
      sourceRecordRef: ref, statusCode: "RECEIVED",
      sourceObservedAt: new Date("2026-09-09T09:00:00Z"),
    }));

    const stale = await statusIntake.receive(deptEvent(w, {
      sourceRecordRef: ref, statusCode: "PARTIALLY_RECEIVED",
      sourceObservedAt: new Date("2026-09-01T09:00:00Z"),
    }));
    expect(stale.outcome).toBe("NOOP");
    expect(stale.note).toMatch(/is already recorded; this one is older/i);

    const current = await DepartmentStatusProjection.findOne({
      companyId: w.co._id, sourceRecordRef: ref, isCurrent: true,
    }).lean();
    expect(current.statusCode).toBe("RECEIVED");
  });

  test("a newer observation supersedes, and the previous row is KEPT", async () => {
    const w = await world();
    const ref = `GRN-hist-${++seq}`;
    await statusIntake.receive(deptEvent(w, {
      sourceRecordRef: ref, statusCode: "PARTIALLY_RECEIVED",
      sourceObservedAt: new Date("2026-09-03T09:00:00Z"),
    }));
    await statusIntake.receive(deptEvent(w, {
      sourceRecordRef: ref, statusCode: "RECEIVED",
      sourceObservedAt: new Date("2026-09-09T09:00:00Z"),
    }));

    const all = await DepartmentStatusProjection.find({
      companyId: w.co._id, sourceRecordRef: ref,
    }).sort({ sourceObservedAt: 1 }).lean();
    expect(all).toHaveLength(2);
    expect(all[0].isCurrent).toBe(false);
    expect(all[0].statusCode).toBe("PARTIALLY_RECEIVED");
    expect(all[1].isCurrent).toBe(true);
    /* One current row, enforced by the partial unique index. */
    expect(all.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  test("an event for a cancelled file is a NOOP", async () => {
    const w = await world();
    await ExecutionFile.updateOne({ _id: w.fileId }, { $set: { lifecycleStatus: "CANCELLED" } });
    const out = await statusIntake.receive(deptEvent(w));
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/cancelled with the order/i);
  });
});

/* ══ 2 — NO GATE IS ANOTHER DEPARTMENT'S READINESS ════════════════════════ */

describe("the completeness gates are Merchandising's own facts only", () => {
  test("not one gate key mentions another department's readiness", () => {
    for (const key of Object.values(GATE)) {
      expect(key).not.toMatch(/stock|supplier|capacity|planning|quality|logistics|store|ppc|production/i);
    }
  });

  test("the gate service reads no stock, supplier, capacity or cost record", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/executionPack.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const banned of [
      /require\([^)]*Inventory/, /require\([^)]*StorePurchase/, /require\([^)]*Costing/,
      /\bStockItem\b/, /\bSupplier\b/, /\bPurchaseOrder\b/, /\bconsumption\b/i, /\brate\b/i,
    ]) {
      expect(bare).not.toMatch(banned);
    }
  });

  test("a pack submits with EVERY department UNKNOWN", async () => {
    /* The headline claim. Merchandising's work being finished is a fact about
       Merchandising; PPC decides what to do about the unknowns. */
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);

    const status = await call(`/files/${w.fileId}/department-status`, at(w, c.viewer));
    expect(status.body.counts.available).toBe(0);
    expect(status.body.counts.unknown + status.body.counts.unavailable).toBe(8);

    const draft = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });
    expect(draft.status).toBe(201);

    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const submitted = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe("SUBMITTED");
  });

  test("each gate fails independently, with its own sentence", async () => {
    const w = await world();
    const c = await cast(w.co);
    const preview = await call(`/files/${w.fileId}/pack/preview`, at(w, c.viewer));
    expect(preview.status).toBe(200);

    /* Nothing has been approved on this file, so exactly the four approval
       gates fail — named, so a gate silently flipping to always-pass is
       caught. Each says what is missing and which tab fixes it. */
    const failed = preview.body.completeness.gates.filter((g) => !g.passed);
    expect(failed.map((g) => g.key).sort()).toEqual([
      GATE.DEVELOPMENT_APPROVED, GATE.MATERIAL_TRIM_APPROVED,
      GATE.PACKAGING_APPROVED, GATE.TNA_BASELINED,
    ].sort());
    for (const g of failed) expect(g.detail.length).toBeGreaterThan(20);

    /* And the three that are genuinely satisfied by acceptance alone pass:
       the handover, the units it created, and an approval register with
       nothing outstanding. */
    const passed = preview.body.completeness.gates.filter((g) => g.passed).map((g) => g.key);
    expect(passed.sort()).toEqual([
      GATE.APPROVALS_SETTLED, GATE.HANDOVER_ACCEPTED, GATE.UNITS_RECONCILE,
    ].sort());
  });

  test("a refused submission lists EVERY failed gate, not the first", async () => {
    const w = await world();
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    expect(res.body.error.code).toBe("PACK_GATE_FAILED");
    expect(res.body.error.details.gates.length).toBe(4);
    /* And it says, in the payload, that no gate is somebody else's readiness. */
    expect(res.body.error.details.note).toMatch(/never a condition on it/i);
  });

  test("the preview writes nothing at all", async () => {
    const w = await world();
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/pack/preview`, at(w, c.viewer));
    await call(`/files/${w.fileId}/pack/preview`, at(w, c.viewer));
    expect(await ExecutionPack.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("submission is refused without the declaration", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: current.body.pack.revision },
    });
    expect(res.body.error.code).toBe("PACK_DECLARATION_REQUIRED");
  });
});

/* ══ 3 — A SUBMITTED PACK IS FROZEN ═══════════════════════════════════════ */

describe("a submitted pack cannot be edited", () => {
  async function submitted(w, c) {
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    if (res.status !== 200) throw new Error(`submit: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  test("contents, completeness and declaration are all rejected after submission", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);

    for (const mutate of [
      (p) => { p.contents.forecastPosition.milestonesTotal = 99; },
      (p) => { p.completeness.allPassed = false; },
      (p) => { p.declaration.statement = "something else"; },
    ]) {
      const pack = await ExecutionPack.findById(sent.packId);
      mutate(pack);
      await expect(pack.save()).rejects.toThrow(/frozen/i);
    }
  });

  test("the pack records the EXACT versions it was built from", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);
    const pack = await ExecutionPack.findById(sent.packId).lean();

    expect(pack.contents.materialTrim.revisionNo).toBe(1);
    expect(pack.contents.packaging.revisionNo).toBe(1);
    expect(pack.contents.developmentRequirements.revisionNo).toBe(1);
    expect(pack.contents.timeAndAction.baselineNo).toBe(1);
    expect(String(pack.contents.salesHandover.versionId)).toBe(String(w.version._id));
    /* References, not copies: nothing here carries a selection's rows. */
    expect(pack.contents.materialTrim.rows).toBeUndefined();
    /* And the forecast snapshot says when it was taken. */
    expect(pack.contents.forecastPosition.asOf).toBeTruthy();
  });

  test("submitting version 2 supersedes version 1 and KEEPS it readable", async () => {
    const w = await world();
    const c = await cast(w.co);
    const first = await submitted(w, c);

    /* PPC asks for a change, which returns the file and allows a new draft. */
    await ppc(`/inbound-packs/${first.packId}/clarify`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(),
      body: { category: "MISSING_EXECUTION_DETAIL", reason: "The size split needs restating for D1." },
    });

    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const draft = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const second = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: draft.body.pack.revision },
    });
    expect(second.status).toBe(200);
    expect(second.body.packVersionNo).toBe(2);

    const one = await ExecutionPack.findById(first.packId).lean();
    expect(one.state).toBe(PACK_STATE.SUPERSEDED);
    expect(one.supersededByPackVersionNo).toBe(2);
    /* Superseded, not deleted, and its contents are untouched. */
    expect(one.contents.materialTrim.revisionNo).toBe(1);
    expect(one.declaration.statement).toMatch(/version 1/);

    const readable = await call(`/files/${w.fileId}/pack/versions/1`, at(w, c.viewer));
    expect(readable.status).toBe(200);
    expect(readable.body.pack.state).toBe(PACK_STATE.SUPERSEDED);
  });

  test("two concurrent submissions: one wins, one is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const body = { declarationAcknowledged: true, expectedRevision: current.body.pack.revision };

    const [a, b] = await Promise.all([
      call(`/files/${w.fileId}/pack/submit`, { ...at(w, c.approver), method: "POST", key: uniq(), body }),
      call(`/files/${w.fileId}/pack/submit`, { ...at(w, c.owner), method: "POST", key: uniq(), body }),
    ]);
    expect([a, b].filter((r) => r.status === 200)).toHaveLength(1);
    expect(await ExecutionPack.countDocuments({
      companyId: w.co._id, state: PACK_STATE.SUBMITTED,
    })).toBe(1);
  });

  test("two drafts cannot coexist on one file", async () => {
    const w = await world();
    const c = await cast(w.co);
    const first = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });
    expect(first.status).toBe(201);
    const second = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });
    expect(second.body.error.code).toBe("PACK_EXISTS");
  });

  test("a retry with the same key replays instead of submitting twice", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const key = uniq();
    const body = { declarationAcknowledged: true, expectedRevision: current.body.pack.revision };

    const one = await call(`/files/${w.fileId}/pack/submit`, { ...at(w, c.approver), method: "POST", key, body });
    const two = await call(`/files/${w.fileId}/pack/submit`, { ...at(w, c.approver), method: "POST", key, body });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.replayed).toBe(true);
    expect(await ExecutionPack.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a withdrawn version number is never reused", async () => {
    const w = await world();
    const c = await cast(w.co);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const draft = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    await call(`/files/${w.fileId}/pack/withdraw`, {
      ...at(w, c.approver), method: "POST",
      body: { reason: "Assembled against the wrong delivery split.", expectedRevision: draft.body.pack.revision },
    });
    const next = await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    expect(next.body.packVersionNo).toBe(2);
  });
});

/* ══ 4 — PPC OWNS THE RECEIVING DECISION ══════════════════════════════════ */

describe("the receiving decision is PPC's", () => {
  async function submitted(w, c) {
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const res = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    if (res.status !== 200) throw new Error(`submit: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  test("Merchandising has no route that writes a receipt", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/handoverPackRoute.js"), "utf8",
    );
    const receiptRoutes = [...src.matchAll(/router\.(get|post|patch|put|delete)\("([^"]*receipt[^"]*)"/g)];
    for (const [, verb] of receiptRoutes) expect(verb).toBe("get");
  });

  test("no Merchandising service writes a PPC decision", () => {
    /* Importing the model is fine and increasingly common — the pack service,
       the reports and the exports all READ what PPC decided. What no
       Merchandising service may do is CREATE a receipt or write the decision
       fields on one, because that is PPC stating something.

       One deliberate exception, stated: the Sales-cancellation mirror moves a
       receipt's state to CANCELLED, because a cancelled order must not leave
       a live receipt behind. It writes one field and no decision, and PPC's
       own `decidedBy`/`decidedAt` are preserved underneath. */
    const dir = path.join(__dirname, "../../services/merchandising");
    const importers = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
      .filter((f) => /DownstreamHandoverReceipt/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    /* There ARE importers — the claim is about what they do, not that they
       exist. */
    expect(importers.length).toBeGreaterThan(0);

    for (const f of importers) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      /* Nobody mints a receipt. */
      expect(bare).not.toMatch(/DownstreamHandoverReceipt\.create/, f);
      /* And nobody writes a decision onto one. */
      expect(bare).not.toMatch(/\.decidedBy\s*=/, f);
      expect(bare).not.toMatch(/\.decidedAt\s*=/, f);
      expect(bare).not.toMatch(/\.clarification\s*=/, f);
    }

    /* ── THE TWO STATE MIRRORS, AND THEY ARE THE ONLY ONES ──────────────
       Both move a receipt whose SUBJECT stopped being current, and neither
       states anything on PPC's behalf:

         executionPack   version n+1 was submitted, so n's receipt becomes
                         SUPERSEDED
         handoverIntake  Sales cancelled the order, so the receipt becomes
                         CANCELLED_BY_MERCHANDISING

       PPC's own `decidedBy` and `decidedAt` are preserved underneath in both,
       which the supersession test asserts directly. A third file appearing
       here would need the same justification. */
    const writers = importers.filter((f) => {
      const bare = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /Receipt\.state\s*=|receipt\.state\s*=/.test(bare);
    });
    expect(writers.sort()).toEqual(["executionPack.service.js", "handoverIntake.service.js"]);
  });

  test("a Merchandising owner is refused on PPC's route", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);
    for (const who of [c.owner, c.approver, c.admin, c.sales]) {
      const res = await ppc(`/inbound-packs/${sent.packId}/accept`, {
        ...at(w, who), method: "POST", key: uniq(), body: {},
      });
      expect(res.status).toBe(403);
    }
  });

  test("a PPC viewer may read the queue but not decide; an approver may", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);

    const queue = await ppc("/inbound-packs", at(w, c.ppcViewer));
    expect(queue.status).toBe(200);
    expect(queue.body.rows.map((r) => r.packId)).toContain(sent.packId);
    expect(queue.body.rows[0].receiptState).toBe("PENDING");

    const denied = await ppc(`/inbound-packs/${sent.packId}/accept`, {
      ...at(w, c.ppcViewer), method: "POST", key: uniq(), body: {},
    });
    expect(denied.status).toBe(403);

    const allowed = await ppc(`/inbound-packs/${sent.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });
    expect(allowed.status).toBe(200);
  });

  test("acceptance is what makes the file HANDED_OVER", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);

    /* Submitting alone does NOT hand over — the decision is not made yet. */
    let file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.executionPhase).toBe("PACK_SUBMITTED");

    await ppc(`/inbound-packs/${sent.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });

    file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBe("HANDED_OVER");
    expect(file.executionPhase).toBe("HANDED_OVER");
    expect(file.downstreamReceiptState).toBe(RECEIPT_STATE.ACCEPTED);
    expect(file.currentPackVersionNo).toBe(1);
  });

  test("superseding an ACCEPTED pack takes the handover back", async () => {
    /* PPC accepted version 1, so the file is handed over. Merchandising then
       sends version 2. The accepted thing has been replaced and nobody has
       accepted its replacement — showing the file as handed over would rest
       on a decision about a version no longer in force. */
    const w = await world();
    const c = await cast(w.co);
    const first = await submitted(w, c);
    await ppc(`/inbound-packs/${first.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });
    expect((await ExecutionFile.findById(w.fileId).lean()).lifecycleStatus).toBe("HANDED_OVER");

    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const draft = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const second = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: draft.body.pack.revision },
    });
    expect(second.status).toBe(200);

    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.executionPhase).toBe("PACK_SUBMITTED");
    expect(file.currentPackVersionNo).toBe(2);
    expect(file.downstreamReceiptState).toBeNull();

    /* PPC's decision on version 1 is PRESERVED — it stays true that they
       accepted it, even though it is no longer the version in force. */
    const one = await DownstreamHandoverReceipt.findOne({
      companyId: w.co._id, packVersionNo: 1,
    }).lean();
    expect(one.state).toBe(RECEIPT_STATE.SUPERSEDED);
    expect(one.decidedAt).toBeTruthy();
    expect(one.decidedBy.name).toBeTruthy();
  });

  test("clarification returns the file to OPEN, with its category and reason", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);

    const res = await ppc(`/inbound-packs/${sent.packId}/clarify`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(),
      body: { category: "DATE_NOT_ACHIEVABLE", reason: "Line capacity cannot meet the 1 December date." },
    });
    expect(res.status).toBe(200);

    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.executionPhase).toBe("COORDINATION");

    const receipt = await call(`/files/${w.fileId}/pack/receipt`, at(w, c.viewer));
    expect(receipt.body.receipt.state).toBe("CLARIFICATION_REQUESTED");
    expect(receipt.body.receipt.clarification.category).toBe("DATE_NOT_ACHIEVABLE");
    expect(receipt.body.receipt.clarification.reason).toMatch(/1 December/);
  });

  test("a short clarification reason is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);
    const res = await ppc(`/inbound-packs/${sent.packId}/clarify`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(),
      body: { category: "OTHER", reason: "no" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.minimum).toBe(15);
  });

  test("there is no REJECTED state anywhere in the contract", () => {
    expect(Object.values(RECEIPT_STATE)).not.toContain("REJECTED");
    const enumValues = DownstreamHandoverReceipt.schema.path("state").enumValues;
    expect(enumValues).not.toContain("REJECTED");

    const routeSrc = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/PPC/inboundPacksRoute.js"), "utf8",
    );
    const bare = routeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/reject/i);
  });

  test("a pack cannot be decided twice", async () => {
    const w = await world();
    const c = await cast(w.co);
    const sent = await submitted(w, c);
    await ppc(`/inbound-packs/${sent.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });
    const again = await ppc(`/inbound-packs/${sent.packId}/clarify`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(),
      body: { category: "OTHER", reason: "Changing my mind after the fact." },
    });
    expect(again.body.error.code).toBe("PACK_ALREADY_DECIDED");
    expect(await DownstreamHandoverReceipt.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("PPC cannot see a draft, only what was actually sent", async () => {
    const w = await world();
    const c = await cast(w.co);
    const draft = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });
    const res = await ppc(`/inbound-packs/${draft.body.packId}`, at(w, c.ppcViewer));
    expect(res.body.error.code).toBe("PACK_NOT_FOUND");
  });
});

/* ══ THE HANDED OVER VIEW, AND DELIVERY ═══════════════════════════════════ */

describe("the Handed Over view is functional", () => {
  test("HANDED_OVER is a real lifecycle value the register can return", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const sent = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    await ppc(`/inbound-packs/${sent.body.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });

    const view = await call("/files?view=handed-over", at(w, c.viewer));
    expect(view.status).toBe(200);
    expect(view.body.rows.map((r) => r.id)).toContain(w.fileId);

    const row = view.body.rows.find((r) => r.id === w.fileId);
    expect(row.handover.packVersionNo).toBe(1);
    expect(row.handover.receiptState).toBe("ACCEPTED");

    const overview = await call("/execution/overview", at(w, c.viewer));
    expect(overview.body.counts.handedOverFiles).toBe(1);
    expect(overview.body.counts.awaitingPpcDecision).toBe(0);
  });

  test("a submitted-but-undecided pack counts as awaiting, not handed over", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    const overview = await call("/execution/overview", at(w, c.viewer));
    expect(overview.body.counts.awaitingPpcDecision).toBe(1);
    expect(overview.body.counts.handedOverFiles).toBe(0);
  });

  test("the submission's announcement is delivered, and is retryable if not", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const sent = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    expect(sent.body.downstream.pending).toBe(0);

    const event = await MerchandisingOutboxEvent.findOne({
      companyId: w.co._id, kind: OUTBOX_KIND.PACK_SUBMITTED,
    }).lean();
    expect(event.status).toBe("DELIVERED");
    expect(event.attempts).toBe(1);

    /* And a row that cannot be carried stays PENDING with the reason, rather
       than reaching a terminal failed state nobody would notice. */
    const orphan = await MerchandisingOutboxEvent.create({
      companyId: w.co._id, kind: OUTBOX_KIND.PACK_SUBMITTED,
      payload: {
        executionFileId: new mongoose.Types.ObjectId(w.fileId),
        packId: new mongoose.Types.ObjectId(), packVersionNo: 99,
      },
      correlationId: `c-${++seq}`,
    });
    const swept = await packDelivery.deliverPending({ companyId: w.co._id });
    expect(swept.pending).toBe(1);
    const after = await MerchandisingOutboxEvent.findById(orphan._id).lean();
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/not readable/i);

    const pending = await call("/downstream/delivery", at(w, c.viewer));
    expect(pending.body.pending).toBe(1);
  });
});

/* ══ COMPANY ISOLATION AND CAPABILITIES ═══════════════════════════════════ */

describe("nothing crosses a company boundary", () => {
  test("company B cannot read or act on company A's pack or status", async () => {
    const a = await world();
    const b = await world();
    const ca = await cast(a.co);
    await makeSubmittable(a);
    await call(`/files/${a.fileId}/pack`, { ...at(a, ca.approver), method: "POST", key: uniq() });

    const intruder = await actor({ companies: [b.co], grants: { merchandiser: "owner", ppc: "approver" } });
    for (const [p, method, body] of [
      [`/files/${a.fileId}/department-status`, "GET", undefined],
      [`/files/${a.fileId}/pack`, "GET", undefined],
      [`/files/${a.fileId}/pack/versions`, "GET", undefined],
      [`/files/${a.fileId}/pack`, "POST", {}],
      [`/files/${a.fileId}/pack/submit`, "POST", { declarationAcknowledged: true, expectedRevision: 0 }],
    ]) {
      const res = await call(p, { token: intruder.token, company: b.co._id, method, body, key: uniq() });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }

    /* And PPC's queue in company B does not hold company A's pack. */
    const queue = await ppc("/inbound-packs?view=all", { token: intruder.token, company: b.co._id });
    expect(queue.body.rows.every((r) => r.fileId !== a.fileId)).toBe(true);
  });
});

describe("the capability matrix", () => {
  test("a viewer reads but cannot draft; an approver can", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await call(`/files/${w.fileId}/pack`, at(w, c.viewer))).status).toBe(200);
    expect((await call(`/files/${w.fileId}/department-status`, at(w, c.viewer))).status).toBe(200);

    const denied = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
    });
    expect(denied.status).toBe(403);
    const allowed = await call(`/files/${w.fileId}/pack`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });
    expect(allowed.status).toBe(201);
  });

  test("a platform admin and a Sales grant reach nothing", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const who of [c.admin, c.sales]) {
      expect((await call(`/files/${w.fileId}/pack`, at(w, who))).status).toBe(403);
      expect((await call(`/files/${w.fileId}/department-status`, at(w, who))).status).toBe(403);
      expect((await ppc("/inbound-packs", at(w, who))).status).toBe(403);
    }
  });

  test("a revoked grant stops working on the very next request", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await call(`/files/${w.fileId}/pack`, at(w, c.viewer))).status).toBe(200);
    await DepartmentRole.updateMany({ email: c.viewer.email }, { $set: { isActive: false } });
    /* The JWT is unchanged and still valid; authority is read live. */
    expect((await call(`/files/${w.fileId}/pack`, at(w, c.viewer))).status).toBe(403);
  });

  test("a downgraded PPC approver loses the decision on the next request", async () => {
    const w = await world();
    const c = await cast(w.co);
    await makeSubmittable(w);
    await call(`/files/${w.fileId}/pack`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const current = await call(`/files/${w.fileId}/pack`, at(w, c.viewer));
    const sent = await call(`/files/${w.fileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { declarationAcknowledged: true, expectedRevision: current.body.pack.revision },
    });
    await DepartmentRole.updateMany(
      { email: c.ppcApprover.email, departmentSlug: "ppc" }, { $set: { role: "viewer" } },
    );
    const res = await ppc(`/inbound-packs/${sent.body.packId}/accept`, {
      ...at(w, c.ppcApprover), method: "POST", key: uniq(), body: {},
    });
    expect(res.status).toBe(403);
  });
});

/* ══ NO AUTHORITY IMPORTED FROM ANOTHER DEPARTMENT ════════════════════════ */

describe("the M6 surface imports no other department's authority", () => {
  const files = [
    "services/merchandising/executionPack.service.js",
    "services/merchandising/departmentStatus.service.js",
    "services/merchandising/departmentStatusIntake.service.js",
    "services/merchandising/departmentStatus.contract.js",
    "routes/CMS_Routes/Merchandising/handoverPackRoute.js",
    "routes/CMS_Routes/PPC/inboundPacksRoute.js",
    "services/ppc/inboundPack.service.js",
  ];

  test("no rate, supplier, PO, consumption, stock decision or release verb", () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, "../..", f), "utf8");
      const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const banned of [
        /\bunitRate\b/, /\bsupplierId\b/, /\bpurchaseOrder\b/i, /\bconsumption\b/i,
        /\bmargin\b/i, /\ballocateCapacity\b/i, /\breleaseToProduction\b/i, /\bbookCapacity\b/i,
      ]) {
        expect(bare).not.toMatch(banned, `${f}: ${banned}`);
      }
    }
  });

  test("PPC's service never edits a Merchandising record beyond the mirror", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/ppc/inboundPack.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    /* It may not touch a selection, a milestone, an assignment or a note. */
    for (const banned of [
      /SelectionRevision/, /TnaMilestone/, /responsibleMerchandiser/,
      /coordinationNote/, /ApprovalRegister/,
    ]) {
      expect(bare).not.toMatch(banned);
    }
    /* And it never rewrites what was handed to it. */
    expect(bare).not.toMatch(/pack\.contents\s*=/);
    expect(bare).not.toMatch(/pack\.completeness\s*=/);
    expect(bare).not.toMatch(/pack\.declaration\s*=/);
  });
});
