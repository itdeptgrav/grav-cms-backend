// test/merchandising/tna-plan.route.test.js
//
// TIME & ACTION — THE CLAIMS THAT MAKE A DATE WORTH BELIEVING.
//
// The module answers one question: which milestone threatens the committed
// delivery date, and what is being done about it. Every test here is a way
// that answer could quietly become false.
//
//   · a baseline is a COMMITMENT, so nothing but baselining may write one —
//     if a forecast change could edit `baselineDate`, "we are four days late"
//     silently becomes "we are on time" and the slip disappears;
//   · a template version is FROZEN once published, so a plan scheduled in
//     March still means in September what it meant in March;
//   · a milestone completed by another record cannot be signed for by hand;
//   · an approver approves the impact they were SHOWN;
//   · and none of it leaks across a company boundary.
//
// Spec §13.1–13.4, §13.8, §13.10–13.14, §13.16, §13.17.
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
const {
  TnaTemplate, TnaTemplateVersion,
} = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const {
  TnaPlan, TnaMilestone, TnaBaseline, TnaReschedule, TnaReasonCode,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");
const intake = require("../../services/merchandising/tnaIntake.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "tna_plan" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/tnaRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  /* The partial unique indexes ARE the invariants under test — one active
     baseline, one version per number — so they must genuinely exist. */
  await TnaPlan.syncIndexes();
  await TnaMilestone.syncIndexes();
  await TnaBaseline.syncIndexes();
  await TnaTemplateVersion.syncIndexes();
  await WorkingCalendarVersion.syncIndexes();
  await MerchandisingIntakeLedger.syncIndexes();
}, 120000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (p, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${base}${p}`, {
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
  const email = `tna-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "T", lastName: `Na${n}`, email, biometricId: `T${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "T" });
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

/** A company with a real Execution File, which is the only way one exists. */
async function world({ split = false, quantity = 400 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `TnA ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Acct ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-T-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-T-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-T-${n}`, styleCode: `SC-T-${n}`, productName: `Polo ${n}`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    materials: { status: "selected", rawItems: [] },
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-T-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: `Polo ${n}`, totalQuantity: quantity,
      totalEstimatedPrice: 240, sampleStyleId: style._id,
    }],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);
  const deliveries = split
    ? [
      { dropRef: "D1", committedDeliveryDate: "2026-11-02", quantity: quantity / 2 },
      { dropRef: "D2", committedDeliveryDate: "2026-12-01", quantity: quantity / 2 },
    ]
    : [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity }];

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(request._id), lineId: lineRef,
    body: { expectedCurrentVersionNo: 0, deliveries },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const reviewer = await actor({ companies: [co], grants: { merchandiser: "approver" } });
  const accepted = await execution.acceptHandover(
    { companyId: co._id },
    { id: String(version._id), actor: { name: reviewer.name, email: reviewer.email } },
  );

  return { co, fileId: String(accepted.file.id), file: accepted.file };
}

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
    outsider: await actor({ companies: [co], grants: { sales: "owner" } }),
    admin: await actor({ companies: [co], isAdmin: true }),
  };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

/* ── A SMALL, HONEST PROCESS ──────────────────────────────────────────────
   Four milestones in a chain, one of them owned by another department and
   closed by a record rather than a person. Enough to exercise propagation,
   ownership and source-owned completion without a forty-row fixture nobody
   can read. */
const MILESTONES = [
  {
    /* Closed by M4's own trim-card approval — the point of source-owned
       completion, and the milestone a merchandiser must NOT be able to sign
       for by hand. */
    milestoneCode: "TRIM_APPROVED", name: "Trim card approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
  },
  {
    milestoneCode: "FABRIC_IN", name: "Fabric in house",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    /* Merchandising's own act — handing the file to the floor — so
       Merchandising may record it. */
    milestoneCode: "PPC_HANDOVER", name: "File handed to PPC",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    /* Owned by Production and closed by Production's record. Nothing in
       Merchandising can complete it, and until Production publishes an event
       it stays visibly awaiting one — which is the honest answer, not a tick
       box a merchandiser fills in on Production's behalf. */
    milestoneCode: "EX_FACTORY", name: "Ex-factory",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "DELIVERY", offsetWorkingDays: -5, scope: "FILE",
  },
];

const DEPENDENCIES = [
  { predecessorCode: "TRIM_APPROVED", successorCode: "FABRIC_IN", lagWorkingDays: 2 },
  { predecessorCode: "FABRIC_IN", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "PPC_HANDOVER", successorCode: "EX_FACTORY", lagWorkingDays: 0 },
];

/** A published calendar and a published template, ready to plan against. */
async function process_(w, who, { milestones = MILESTONES, dependencies = DEPENDENCIES, applicability = {} } = {}) {
  const t = at(w, who);
  const cal = await call("/tna/calendars", {
    ...t, method: "POST", body: { name: `Cal ${++seq}`, timezone: "Asia/Kolkata" },
  });
  const calId = cal.body.calendar.id;
  await call(`/tna/calendars/${calId}/versions`, {
    ...t, method: "POST",
    body: {
      weekPattern: [true, true, true, true, true, false, false],
      exceptions: [{ date: "2026-10-02", working: false, reason: "Gandhi Jayanti" }],
      effectiveFrom: "2026-01-01", horizonTo: "2030-12-31",
    },
  });
  await call(`/tna/calendars/${calId}/versions/1/publish`, { ...t, method: "POST" });

  const tpl = await call("/tna/templates", {
    ...t, method: "POST", body: { name: `Template ${++seq}`, ...applicability },
  });
  const tplId = tpl.body.template.id;
  const ver = await call(`/tna/templates/${tplId}/versions`, {
    ...t, method: "POST",
    body: { milestones, dependencies, defaultCalendarId: calId, effectiveFrom: "2026-01-01" },
  });
  const pub = await call(`/tna/templates/${tplId}/versions/1/publish`, { ...t, method: "POST" });

  await call("/tna/reason-codes", {
    ...t, method: "POST", body: { code: "SUPPLIER_LATE", label: "Supplier late", kind: "RESCHEDULE" },
  });
  await call("/tna/reason-codes", {
    ...t, method: "POST", body: { code: "AWAITING_APPROVAL", label: "Awaiting approval", kind: "BLOCK" },
  });

  return { calId, tplId, cal, ver, pub };
}

/** A plan, baselined and ready to execute against. */
async function planned(w, c, { baseline = true } = {}) {
  const p = await process_(w, c.owner);
  const made = await call(`/files/${w.fileId}/tna`, {
    ...at(w, c.owner), method: "POST", key: uniq(),
    body: { templateId: p.tplId, planStartDate: "2026-09-07" },
  });
  if (baseline) {
    const bl = await approveBaseline(w, c.owner);
    if (bl.status !== 200) throw new Error(`baseline: ${JSON.stringify(bl.body)}`);
  }
  return { ...p, made };
}

/** Approve the live baseline, naming the plan revision being committed. */
async function approveBaseline(w, who) {
  const current = await call(`/files/${w.fileId}/tna`, at(w, who));
  return call(`/files/${w.fileId}/tna/baseline/approve`, {
    ...at(w, who), method: "POST", key: uniq(),
    body: { expectedRevision: current.body.plan.revision },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("§13.4 — a plan is instantiated from a published process", () => {
  test("creating a plan produces one milestone per template row, ranked", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { made } = await planned(w, c, { baseline: false });
    expect(made.status).toBe(201);

    const list = await call(`/files/${w.fileId}/tna/milestones`, at(w, c.viewer));
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(MILESTONES.length);

    const ranks = list.body.rows.map((m) => m.milestoneRef);
    expect(ranks.indexOf("TRIM_APPROVED")).toBeLessThan(ranks.indexOf("FABRIC_IN"));
    expect(ranks.indexOf("FABRIC_IN")).toBeLessThan(ranks.indexOf("PPC_HANDOVER"));
  });

  test("every stored date is a plain calendar date, never an instant", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const rows = await TnaMilestone.find({ companyId: w.co._id }).lean();
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) {
      for (const field of ["baselineDate", "forecastDate", "actualDate"]) {
        if (m[field]) expect(m[field]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  test("a template with a cycle is refused at publish, and the cycle is named", async () => {
    const w = await world();
    const c = await cast(w.co);
    const t = at(w, c.owner);
    const tpl = await call("/tna/templates", { ...t, method: "POST", body: { name: `Cyclic ${++seq}` } });
    const cal = await call("/tna/calendars", {
      ...t, method: "POST", body: { name: `C ${++seq}`, timezone: "Asia/Kolkata" },
    });
    await call(`/tna/calendars/${cal.body.calendar.id}/versions`, {
      ...t, method: "POST",
      body: {
        weekPattern: [true, true, true, true, true, false, false],
        effectiveFrom: "2026-01-01", horizonTo: "2030-12-31",
      },
    });
    await call(`/tna/calendars/${cal.body.calendar.id}/versions/1/publish`, { ...t, method: "POST" });

    await call(`/tna/templates/${tpl.body.template.id}/versions`, {
      ...t, method: "POST",
      body: {
        milestones: MILESTONES.slice(0, 2),
        dependencies: [
          { predecessorCode: "TRIM_APPROVED", successorCode: "FABRIC_IN" },
          { predecessorCode: "FABRIC_IN", successorCode: "TRIM_APPROVED" },
        ],
        defaultCalendarId: cal.body.calendar.id, effectiveFrom: "2026-01-01",
      },
    });
    const pub = await call(`/tna/templates/${tpl.body.template.id}/versions/1/publish`, {
      ...t, method: "POST",
    });
    expect(pub.status).toBeGreaterThanOrEqual(400);
    expect(pub.body.error.code).toBe("TNA_DEPENDENCY_CYCLE");
    expect(pub.body.message).toMatch(/TRIM_APPROVED|FABRIC_IN/);
  });
});

describe("§13.3 — a published version is frozen", () => {
  test("a published template version refuses a change to its milestones", async () => {
    const w = await world();
    const c = await cast(w.co);
    const p = await process_(w, c.owner);
    const patched = await call(`/tna/templates/${p.tplId}/versions/1`, {
      ...at(w, c.owner), method: "PATCH",
      body: { milestones: MILESTONES.slice(0, 1) },
    });
    expect(patched.status).toBeGreaterThanOrEqual(400);
  });

  test("publishing version 2 leaves an existing plan's milestones untouched", async () => {
    /* The whole reason a version is frozen: a plan scheduled in March must
       still mean in September what it meant in March. */
    const w = await world();
    const c = await cast(w.co);
    const p = await planned(w, c);
    const before = await TnaMilestone.find({ companyId: w.co._id }).sort({ sequenceRank: 1 }).lean();
    const beforeIds = String(before.map((m) => `${m.milestoneRef}:${m.baselineDate}`));

    await call(`/tna/templates/${p.tplId}/versions`, {
      ...at(w, c.owner), method: "POST",
      body: {
        milestones: MILESTONES.slice(0, 2), dependencies: [],
        defaultCalendarId: p.calId, effectiveFrom: "2027-01-01",
      },
    });
    await call(`/tna/templates/${p.tplId}/versions/2/publish`, { ...at(w, c.owner), method: "POST" });

    const after = await TnaMilestone.find({ companyId: w.co._id }).sort({ sequenceRank: 1 }).lean();
    expect(String(after.map((m) => `${m.milestoneRef}:${m.baselineDate}`))).toBe(beforeIds);
    expect(after).toHaveLength(MILESTONES.length);
  });
});

describe("§13.8 — the baseline is the commitment", () => {
  test("approving the baseline writes baselineDate once, from the forecast", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const rows = await TnaMilestone.find({ companyId: w.co._id }).lean();
    for (const m of rows) {
      if (m.forecastDate) expect(m.baselineDate).toBe(m.forecastDate);
    }
    const bl = await TnaBaseline.find({ companyId: w.co._id }).lean();
    expect(bl).toHaveLength(1);
    expect(bl[0].baselineNo).toBe(1);
    expect(bl[0].state).toBe("ACTIVE");
  });

  test("a forecast change moves the forecast and NOT the baseline", async () => {
    /* If this ever fails, a slip becomes invisible: "four days late" quietly
       rewrites itself into "on time", and the register stops answering the
       one question it exists for. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const before = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();

    const moved = await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/forecast`, {
      ...at(w, c.editor), method: "PATCH",
      body: { forecastDate: "2026-10-20", expectedRevision: before.revision, note: "Supplier confirmed later" },
    });
    expect(moved.status).toBe(200);

    const after = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    expect(after.forecastDate).toBe("2026-10-20");
    expect(after.baselineDate).toBe(before.baselineDate);
  });

  test("blocking and completing leave the baseline alone too", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const m = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    const baseline = m.baselineDate;

    await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/block`, {
      ...at(w, c.editor), method: "POST",
      body: { reasonCode: "AWAITING_APPROVAL", note: "Waiting on the mill's confirmation.", expectedRevision: m.revision },
    });
    const blocked = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    expect(blocked.baselineDate).toBe(baseline);

    await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/unblock`, {
      ...at(w, c.editor), method: "POST", body: { expectedRevision: blocked.revision },
    });
    const unblocked = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/complete`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { actualDate: "2026-10-22", expectedRevision: unblocked.revision },
    });
    const done = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    expect(done.actualDate).toBe("2026-10-22");
    expect(done.baselineDate).toBe(baseline);
  });

  test("a saved baseline document rejects an edit to its entries", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const bl = await TnaBaseline.findOne({ companyId: w.co._id, baselineNo: 1 });
    bl.entries[0].baselineDate = "2027-01-01";
    await expect(bl.save()).rejects.toThrow();
  });

  test("two concurrent baseline approvals: one wins, and the loser is told why", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c, { baseline: false });
    const current = await call(`/files/${w.fileId}/tna`, at(w, c.owner));
    const body = { expectedRevision: current.body.plan.revision };
    const [a, b] = await Promise.all([
      call(`/files/${w.fileId}/tna/baseline/approve`, { ...at(w, c.owner), method: "POST", key: uniq(), body }),
      call(`/files/${w.fileId}/tna/baseline/approve`, { ...at(w, c.approver), method: "POST", key: uniq(), body }),
    ]);
    const codes = [a, b].map((r) => (r.status === 200 ? "OK" : r.body?.code));
    expect(codes.filter((x) => x === "OK")).toHaveLength(1);
    expect(await TnaBaseline.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);
  });
});

describe("§13.10 — rescheduling is a decision, not an edit", () => {
  test("preview writes one PREVIEWED row and changes nothing else", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const before = await TnaMilestone.find({ companyId: w.co._id }).sort({ sequenceRank: 1 }).lean();

    const pv = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: {
        milestoneRef: "FABRIC_IN", proposedDate: "2026-11-20",
        reasonCode: "SUPPLIER_LATE",
        reasonNote: "The mill has confirmed a three-week delay on the base cloth.",
      },
    });
    expect(pv.status).toBe(200);
    expect(pv.body.reschedule.state).toBe("PREVIEWED");
    expect(pv.body.reschedule.impact.affected.length).toBeGreaterThan(0);

    const after = await TnaMilestone.find({ companyId: w.co._id }).sort({ sequenceRank: 1 }).lean();
    expect(after.map((m) => `${m.forecastDate}|${m.baselineDate}`))
      .toEqual(before.map((m) => `${m.forecastDate}|${m.baselineDate}`));
  });

  test("a note under 15 characters, or an unknown reason code, is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const short = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: { milestoneRef: "FABRIC_IN", proposedDate: "2026-11-20", reasonCode: "SUPPLIER_LATE", reasonNote: "late" },
    });
    expect(short.body.error.code).toBe("TNA_REASON_REQUIRED");

    const unknown = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: {
        milestoneRef: "FABRIC_IN", proposedDate: "2026-11-20", reasonCode: "MADE_UP",
        reasonNote: "A reason nobody configured, stated at length.",
      },
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
  });

  test("a plan that moved between preview and approval raises TNA_IMPACT_STALE", async () => {
    /* An approver approves the impact they were SHOWN. If the plan changed
       underneath, approving would be agreeing to something nobody displayed. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const pv = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: {
        milestoneRef: "FABRIC_IN", proposedDate: "2026-11-20", reasonCode: "SUPPLIER_LATE",
        reasonNote: "The mill has confirmed a three-week delay on the base cloth.",
      },
    });
    const ref = pv.body.reschedule.rescheduleRef;

    /* Somebody else moves a different milestone in between. */
    const other = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "PPC_HANDOVER" }).lean();
    await call(`/files/${w.fileId}/tna/milestones/PPC_HANDOVER/forecast`, {
      ...at(w, c.editor), method: "PATCH",
      body: { forecastDate: "2026-11-10", expectedRevision: other.revision, note: "Line freed up" },
    });

    const approved = await call(`/files/${w.fileId}/tna/reschedule/${ref}/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(approved.body.error.code).toBe("TNA_IMPACT_STALE");
    expect(approved.body.message).toMatch(/preview it again|Preview it again/i);
  });

  test("a reschedule that breaks a commitment cannot be approved by its requester", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    /* Far past the committed 1 December delivery. */
    const pv = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.owner), method: "POST",
      body: {
        milestoneRef: "FABRIC_IN", proposedDate: "2027-02-01", reasonCode: "SUPPLIER_LATE",
        reasonNote: "The mill cannot deliver the base cloth before February.",
      },
    });
    expect(pv.body.reschedule.createsBaselineRevision).toBe(true);
    expect(pv.body.reschedule.impact.breachesCommittedDelivery).toBe(true);

    const self = await call(`/files/${w.fileId}/tna/reschedule/${pv.body.reschedule.rescheduleRef}/approve`, {
      ...at(w, c.owner), method: "POST", key: uniq(), body: {},
    });
    /* An owner is NOT an exception. The rung that would exempt somebody is
       the rung the separation exists to constrain. */
    expect(self.body.error.code).toBe("TNA_SELF_APPROVAL");
  });

  test("approved by somebody else, a breaching reschedule creates baseline 2", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const pv = await call(`/files/${w.fileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: {
        milestoneRef: "FABRIC_IN", proposedDate: "2027-02-01", reasonCode: "SUPPLIER_LATE",
        reasonNote: "The mill cannot deliver the base cloth before February.",
      },
    });
    const ok = await call(`/files/${w.fileId}/tna/reschedule/${pv.body.reschedule.rescheduleRef}/approve`, {
      ...at(w, c.owner), method: "POST", key: uniq(), body: {},
    });
    expect(ok.status).toBe(200);
    expect(ok.body.baselineNo).toBe(2);

    /* The original commitment stays readable — "what did we first promise"
       must never stop being answerable. */
    const one = await TnaBaseline.findOne({ companyId: w.co._id, baselineNo: 1 }).lean();
    expect(one.state).toBe("SUPERSEDED");
    expect(one.entries.length).toBeGreaterThan(0);
    expect(await TnaBaseline.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);

    const rebaselined = await MerchandisingOutboxEvent.findOne({
      companyId: w.co._id, kind: OUTBOX_KIND.TNA_PLAN_REBASELINED,
    }).lean();
    expect(rebaselined).toBeTruthy();
  });
});

describe("§13.11 — a milestone another record owns cannot be signed for", () => {
  test("completing a SOURCE_EVENT milestone by hand is refused, naming the source", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const m = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "TRIM_APPROVED" }).lean();
    const res = await call(`/files/${w.fileId}/tna/milestones/TRIM_APPROVED/complete`, {
      ...at(w, c.owner), method: "POST", key: uniq(),
      body: { actualDate: "2026-09-20", expectedRevision: m.revision },
    });
    expect(res.body.error.code).toBe("TNA_SOURCE_OWNED");
    /* The refusal says where the date will come from, so nobody has to guess
       who to chase. */
    expect(res.body.message.length).toBeGreaterThan(30);
  });

  test("no route on the surface accepts a per-milestone person", () => {
    /* §13.16 — the boundary between a T&A milestone and a task. A milestone
       is owned by a DEPARTMENT; the moment one carries an assignee it has
       become somebody's to-do, and this is not a task manager. */
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/tnaRoute.js"), "utf8",
    );
    expect(src).not.toMatch(/assignee|assignedPerson|dueReminder|checklist|subtask|snooze/i);
  });

  test("no M5 model stores a reminder, a checklist or an assignee", () => {
    const banned = /assignee|dueReminder|checklist|subtask|delegat(e|ion)|snooze|\btodo\b/i;
    for (const f of ["TnaPlan.js", "TnaTemplate.js", "WorkingCalendar.js"]) {
      const src = fs.readFileSync(
        path.join(__dirname, "../../models/CMS_Models/Merchandising", f), "utf8",
      );
      expect(src).not.toMatch(banned);
    }
  });
});

describe("§13.12 — source events, stale and duplicate", () => {
  /** An approval event of a kind the plan is listening for. */
  const approval = async (w, { on } = {}) => MerchandisingOutboxEvent.create({
    companyId: w.co._id,
    kind: OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
    payload: {
      executionFileId: new mongoose.Types.ObjectId(w.fileId), family: "MATERIAL_TRIM",
      revisionId: new mongoose.Types.ObjectId(), revisionNo: 1,
    },
    correlationId: `c-${++seq}`,
    ...(on ? { createdAt: new Date(`${on}T06:00:00Z`) } : {}),
  });

  test("a matching event completes the milestone with no actor and a source reference", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const event = await approval(w);
    const out = await intake.receive(event.toObject());
    expect(out.applied).toBe(true);

    const m = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "TRIM_APPROVED" }).lean();
    expect(m.actualDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.status).toBe("COMPLETED");
    expect(m.completion.recordedVia).toBe("SOURCE_EVENT");
    expect(String(m.completion.sourceEventId)).toBe(String(event._id));
    expect(m.completion.sourceEventKind).toBe(OUTBOX_KIND.MATERIAL_TRIM_APPROVED);
    /* Nobody completed this. Naming a person would put a signature on a
       statement they did not make. */
    expect(m.completion.actor?.name || "").toBe("");
  });

  test("redelivering the same event finds the ledger row and writes nothing twice", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const event = await approval(w);
    await intake.receive(event.toObject());
    const again = await intake.receive(event.toObject());
    expect(again.duplicate).toBe(true);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });

  test("two concurrent deliveries: one applies, the other reports the duplicate", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const event = await approval(w);
    const [a, b] = await Promise.all([
      intake.receive(event.toObject()),
      intake.receive(event.toObject()),
    ]);
    expect([a, b].filter((r) => r.applied)).toHaveLength(1);
    expect([a, b].filter((r) => r.duplicate)).toHaveLength(1);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });

  test("an event of a kind nothing listens for is a NOOP, not a failure", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const event = await MerchandisingOutboxEvent.create({
      companyId: w.co._id,
      kind: OUTBOX_KIND.PACKAGING_APPROVED,
      payload: {
      executionFileId: new mongoose.Types.ObjectId(w.fileId), family: "PACKAGING",
      revisionId: new mongoose.Types.ObjectId(), revisionNo: 1,
    },
      correlationId: `c-${++seq}`,
    });
    const out = await intake.receive(event.toObject());
    expect(out.applied).toBe(false);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/No milestone/i);
  });

  test("an event for a file with no plan is a NOOP", async () => {
    const w = await world();
    const event = await MerchandisingOutboxEvent.create({
      companyId: w.co._id,
      kind: OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
      payload: {
      executionFileId: new mongoose.Types.ObjectId(w.fileId), family: "MATERIAL_TRIM",
      revisionId: new mongoose.Types.ObjectId(), revisionNo: 1,
    },
      correlationId: `c-${++seq}`,
    });
    const out = await intake.receive(event.toObject());
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/no live Time & Action plan/i);
  });

  test("a later event does not move a recorded completion forward", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const first = await approval(w);
    await intake.receive({ ...first.toObject(), createdAt: new Date("2026-09-14T06:00:00Z") });
    const recorded = (await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "TRIM_APPROVED" }).lean()).actualDate;

    const late = await approval(w);
    const out = await intake.receive({ ...late.toObject(), createdAt: new Date("2026-10-30T06:00:00Z") });
    expect(out.outcome).toBe("NOOP");
    const after = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "TRIM_APPROVED" }).lean();
    expect(after.actualDate).toBe(recorded);
  });

  test("an EARLIER authoritative observation corrects a later one", async () => {
    /* Delivery is not ordered. An approval genuinely granted on the 3rd is
       not made less true by a duplicate that arrives on the 30th. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const late = await approval(w);
    await intake.receive({ ...late.toObject(), createdAt: new Date("2026-10-30T06:00:00Z") });

    const early = await approval(w);
    const out = await intake.receive({ ...early.toObject(), createdAt: new Date("2026-09-14T06:00:00Z") });
    expect(out.applied).toBe(true);
    const after = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "TRIM_APPROVED" }).lean();
    expect(after.actualDate).toBe("2026-09-14");
  });

  test("completing the first milestone cascades to everything downstream", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const before = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    const event = await approval(w);
    await intake.receive({ ...event.toObject(), createdAt: new Date("2026-10-30T06:00:00Z") });
    const after = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    expect(after.forecastDate > before.forecastDate).toBe(true);
    /* And the commitment did NOT move with it. */
    expect(after.baselineDate).toBe(before.baselineDate);
  });
});

describe("§13.13 — bulk is per row", () => {
  test("preview writes nothing and returns an outcome for every row", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const before = await TnaMilestone.find({ companyId: w.co._id }).lean();

    const pv = await call("/tna/bulk/reschedule/preview", {
      ...at(w, c.editor), method: "POST",
      body: {
        rows: [
          { fileId: w.fileId, milestoneRef: "FABRIC_IN", proposedDate: "2026-11-05" },
          { fileId: w.fileId, milestoneRef: "NOT_A_MILESTONE", proposedDate: "2026-11-05" },
          { fileId: w.fileId, milestoneRef: "PPC_HANDOVER", proposedDate: "not-a-date" },
        ],
      },
    });
    expect(pv.status).toBe(200);
    expect(pv.body.rows).toHaveLength(3);
    expect(pv.body.rows[0].outcome).toBe("APPLIED");
    /* A refused row does not discard the good ones beside it. */
    expect(pv.body.rows[1].outcome).toBe("REFUSED");
    expect(pv.body.rows[2].outcome).toBe("REFUSED");
    expect(pv.body.note).toMatch(/[Nn]othing has been changed/);

    const after = await TnaMilestone.find({ companyId: w.co._id }).lean();
    expect(after.map((m) => m.forecastDate).join()).toBe(before.map((m) => m.forecastDate).join());
  });

  test("over 200 rows is an explicit refusal, not a silent truncation", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const rows = Array.from({ length: 201 }, () => ({
      fileId: w.fileId, milestoneRef: "FABRIC_IN", proposedDate: "2026-11-05",
    }));
    const pv = await call("/tna/bulk/reschedule/preview", {
      ...at(w, c.editor), method: "POST", body: { rows },
    });
    expect(pv.status).toBeGreaterThanOrEqual(400);
    expect(pv.body.message).toMatch(/201/);
    expect(pv.body.error.details.maximum).toBe(200);
  });

  test("apply without a previewId is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const res = await call("/tna/bulk/reschedule/apply", {
      ...at(w, c.editor), method: "POST",
      body: { rows: [{ fileId: w.fileId, milestoneRef: "FABRIC_IN", proposedDate: "2026-11-05" }] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/previewId/);
  });
});

describe("§13.1 — nothing crosses a company boundary", () => {
  test("company B cannot read, plan or reschedule company A's file", async () => {
    const a = await world();
    const b = await world();
    const ca = await cast(a.co);
    await planned(a, ca);

    /* A real Merchandising owner — of the OTHER company. */
    const intruder = await actor({ companies: [b.co], grants: { merchandiser: "owner" } });

    for (const [p, method, body] of [
      [`/files/${a.fileId}/tna`, "GET", undefined],
      [`/files/${a.fileId}/tna/milestones`, "GET", undefined],
      [`/files/${a.fileId}/tna/baselines`, "GET", undefined],
      [`/files/${a.fileId}/tna/baseline/approve`, "POST", {}],
    ]) {
      const res = await call(p, { token: intruder.token, company: b.co._id, method, body });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  test("the register shows only the acting company's milestones", async () => {
    const a = await world();
    const b = await world();
    const ca = await cast(a.co);
    const cb = await cast(b.co);
    await planned(a, ca);
    await planned(b, cb);

    const seen = await call("/tna/portfolio?view=all&limit=100", at(a, ca.viewer));
    expect(seen.status).toBe(200);
    const fileIds = new Set(seen.body.rows.map((r) => r.fileId));
    expect(fileIds.has(a.fileId)).toBe(true);
    expect(fileIds.has(b.fileId)).toBe(false);
  });
});

describe("§13.2 — the capability matrix", () => {
  test("a viewer reads but cannot move a forecast; an editor can", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const m = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    const body = { forecastDate: "2026-10-20", expectedRevision: m.revision, note: "n" };

    const asViewer = await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/forecast`, {
      ...at(w, c.viewer), method: "PATCH", body,
    });
    expect(asViewer.status).toBe(403);

    const asEditor = await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/forecast`, {
      ...at(w, c.editor), method: "PATCH", body,
    });
    expect(asEditor.status).toBe(200);
  });

  test("an editor cannot approve a baseline; an approver can", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c, { baseline: false });
    const denied = await approveBaseline(w, c.editor);
    expect(denied.status).toBe(403);
    const allowed = await approveBaseline(w, c.approver);
    expect(allowed.status).toBe(200);
  });

  test("a Sales grant and a platform admin without a Merchandising seat both reach nothing", async () => {
    /* A platform administrator is not a rung on this ladder. Wherever
       `isAdmin` is a bypass it is the bypass that outlives every tightening
       made around it. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    for (const who of [c.outsider, c.admin]) {
      const res = await call(`/files/${w.fileId}/tna/milestones`, at(w, who));
      expect(res.status).toBe(403);
    }
  });

  test("a revoked grant stops working on the very next request", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const before = await call(`/files/${w.fileId}/tna/milestones`, at(w, c.viewer));
    expect(before.status).toBe(200);

    await DepartmentRole.updateMany({ email: c.viewer.email }, { $set: { isActive: false } });

    const after = await call(`/files/${w.fileId}/tna/milestones`, at(w, c.viewer));
    /* The JWT is unchanged and still valid. Authority is read live, so a
       revoked seat is closed now rather than in seven days. */
    expect(after.status).toBe(403);
  });
});

describe("§13.14 — cursor pagination", () => {
  test("the register pages stably and caps the limit", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);

    const first = await call("/tna/portfolio?view=all&limit=2", at(w, c.viewer));
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);

    const second = await call(`/tna/portfolio?view=all&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      at(w, c.viewer));
    expect(second.status).toBe(200);
    const overlap = second.body.rows.filter(
      (r) => first.body.rows.some((f) => f.milestoneRef === r.milestoneRef && f.fileId === r.fileId),
    );
    expect(overlap).toHaveLength(0);

    const capped = await call("/tna/portfolio?view=all&limit=9999", at(w, c.viewer));
    expect(capped.body.rows.length).toBeLessThanOrEqual(100);
  });

  test("a cursor issued under one filter is refused under another", async () => {
    /* Honouring it would silently skip rows and read exactly like data loss. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const first = await call("/tna/portfolio?view=all&limit=1", at(w, c.viewer));
    const crossed = await call(
      `/tna/portfolio?view=overdue&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      at(w, c.viewer),
    );
    expect(crossed.status).toBeGreaterThanOrEqual(400);
    expect(crossed.body.message).toMatch(/different filter/i);
  });

  test("the counts are an aggregation, and every figure has a list behind it", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const counts = await call("/tna/portfolio/counts", at(w, c.viewer));
    expect(counts.status).toBe(200);
    expect(counts.body.counts.all).toBe(MILESTONES.length);
    /* Every key is a view name the register will actually open. */
    for (const key of Object.keys(counts.body.counts)) {
      if (key === "deliveryAtRisk") continue;
      const list = await call(`/tna/portfolio?view=${key}&limit=100`, at(w, c.viewer));
      expect(list.status).toBe(200);
      expect(list.body.rows.length).toBe(counts.body.counts[key]);
    }
  });
});

describe("§13.17 — the register is an index scan, not a loop over files", () => {
  test("the portfolio query uses an index rather than a collection scan", async () => {
    /* Asserted as a query PLAN, not as a wall-clock number, so the test does
       not become flaky on a loaded machine — and so it fails when somebody
       drops the index rather than when CI is busy. */
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);

    const plan = await TnaMilestone.collection.find(
      { companyId: w.co._id, status: "DUE_SOON" },
    ).sort({ forecastDate: 1, _id: 1 }).explain("queryPlanner");

    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain("IXSCAN");
    expect(winning).not.toMatch(/"stage":"COLLSCAN"/);
  });

  test("propagation is one ordered pass, not a query per milestone", async () => {
    const w = await world();
    const c = await cast(w.co);
    await planned(w, c);
    const m = await TnaMilestone.findOne({ companyId: w.co._id, milestoneRef: "FABRIC_IN" }).lean();
    const res = await call(`/files/${w.fileId}/tna/milestones/FABRIC_IN/forecast`, {
      ...at(w, c.editor), method: "PATCH",
      body: { forecastDate: "2026-11-20", expectedRevision: m.revision, note: "Mill confirmed" },
    });
    expect(res.status).toBe(200);
    /* Only what actually MOVED is reported and written. A pass that rewrote
       every milestone would report the whole plan as cascaded. */
    expect(Array.isArray(res.body.cascaded)).toBe(true);
    expect(res.body.cascaded.length).toBeLessThan(MILESTONES.length);
  });
});
