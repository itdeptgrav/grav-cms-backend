// test/merchandising/production-closure.journey.test.js
//
// THE WHOLE MERCHANDISING JOURNEY, END TO END, AS ONE PRODUCT.
//
// Every milestone has its own suite proving its own contract. What none of
// them proves is that the pieces fit: that the reference Sales mints in an
// enquiry is the one a Development File is rooted on, that the revision
// Merchandising approves is the one R&D reads and the one the confirmed order
// adopts, and that a change three months later leaves all of it readable.
//
// A journey assembled from nine correct halves can still be broken at every
// seam, and a seam is exactly where nobody's own test looks. So this walks the
// chain once, in order, through the real routers:
//
//   1  Sales issues a versioned development request against a product line
//   2  Merchandising accepts it and selects the materials
//   3  A second person approves the development BOM
//   4  Sales — not Merchandising — authorises the release to R&D
//   5  R&D reads the approved development selection ahead of the product BOM
//   6  The buyer confirms; a handover opens an Execution File
//   7  The order ADOPTS the approved development selection into a draft
//   8  Time & Action controls the order's dates
//   9  The Execution Pack goes to PPC
//  10  A Sales change lands and nothing earlier is overwritten
//
// It also asserts the boundaries AT each seam rather than in the abstract:
// who may act, who may not, and what is refused when they try.
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
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  DevelopmentFile, DevelopmentBomRevision, LIFECYCLE, BOM_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MaterialTrimRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const {
  PRODUCT_LINE_REF_PATTERN,
} = require("../../models/CMS_Models/Sales/enquiryProductLineIdentity");

const handoverProducer = require("../../services/sales/merchandisingHandover.service");
const handoverDelivery = require("../../services/integration/salesHandoverDelivery.service");

let server, base, salesDev, salesChange, ppcBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "closure_journey" });

  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/developmentRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/tnaRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/handoverPackRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/changeControlRoute"));
  app.use("/api/cms/sales/development-requests",
    require("../../routes/CMS_Routes/Sales/developmentRequests"));
  app.use("/api/cms/sales/change-notices", require("../../routes/CMS_Routes/Sales/changeNotices"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/inboundPacksRoute"));

  await new Promise((r) => { server = app.listen(0, r); });
  const port = server.address().port;
  base = `http://127.0.0.1:${port}/api/cms/merchandising`;
  salesDev = `http://127.0.0.1:${port}/api/cms/sales/development-requests`;
  salesChange = `http://127.0.0.1:${port}/api/cms/sales/change-notices`;
  ppcBase = `http://127.0.0.1:${port}/api/cms/ppc`;

  await DevelopmentFile.syncIndexes();
  await DevelopmentBomRevision.syncIndexes();
  await MerchandisingIntakeLedger.syncIndexes();
}, 180000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const req = (root) => (p, { token, company, method = "GET", body } = {}) =>
  fetch(`${root}${p}`, {
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
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  });

const call = (p, o) => req(base)(p, o);
const sdev = (p, o) => req(salesDev)(p, o);
const schange = (p, o) => req(salesChange)(p, o);
const ppc = (p, o) => req(ppcBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `close-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `Close${n}`, email, biometricId: `CL${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "C",
    });
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
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser",
        employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "20m" },
    ),
  };
}

/** A buyer, a Journey, an enquiry line with a permanent reference, and a style. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Closure ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({
    companyId: co._id, companyName: `Buyer ${n}`, status: "active",
  });
  const journey = await SalesJourney.create({
    journeyId: `SJ-CL-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-CL-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `Polo ${n}`, quantity: 500 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  const style = await SampleStyle.create({
    sampleStyleId: `SS-CL-${n}`, styleCode: `SC-CL-${n}`, productName: `Polo ${n}`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    materials: { status: "pending", rawItems: [] },
  });
  return {
    co, journey, enquiry, style, seq: n,
    productLineRef: String(saved.products[0].productLineRef),
  };
}

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    /* A SECOND approver, because maker/checker needs two real people rather
       than one person and an assertion about them. */
    checker: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
    admin: await actor({ companies: [co], isAdmin: true }),
    salesApprover: await actor({ companies: [co], grants: { sales: "approver" } }),
    salesViewer: await actor({ companies: [co], grants: { sales: "viewer" } }),
    ppcApprover: await actor({ companies: [co], grants: { ppc: "approver" } }),
  };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });
const rev = async (Model, id) => (await Model.findById(id).lean()).revision ?? 0;

/* A small, honest process: two milestones, one of them Merchandising's own. */
const MILESTONES = [
  {
    milestoneCode: "TRIM_APPROVED", name: "Trim card approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
  },
  {
    milestoneCode: "PPC_HANDOVER", name: "File handed to PPC",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
];
const DEPENDENCIES = [
  { predecessorCode: "TRIM_APPROVED", successorCode: "PPC_HANDOVER", lagWorkingDays: 2 },
];

/** A published calendar and template, so a plan can exist at all. */
async function process_(w, who) {
  const t = at(w, who);
  const cal = await call("/tna/calendars", {
    ...t, method: "POST", body: { name: `Cal ${++seq}`, timezone: "Asia/Kolkata" },
  });
  const calId = cal.body.calendar.id;
  await call(`/tna/calendars/${calId}/versions`, {
    ...t, method: "POST",
    body: {
      weekPattern: [true, true, true, true, true, false, false],
      effectiveFrom: "2026-01-01", horizonTo: "2030-12-31",
    },
  });
  await call(`/tna/calendars/${calId}/versions/1/publish`, { ...t, method: "POST" });

  const tpl = await call("/tna/templates", {
    ...t, method: "POST", body: { name: `Template ${++seq}` },
  });
  const tplId = tpl.body.template.id;
  await call(`/tna/templates/${tplId}/versions`, {
    ...t, method: "POST",
    body: {
      milestones: MILESTONES, dependencies: DEPENDENCIES,
      defaultCalendarId: calId, effectiveFrom: "2026-01-01",
    },
  });
  await call(`/tna/templates/${tplId}/versions/1/publish`, { ...t, method: "POST" });
  return { calId, tplId };
}

/** The buyer confirms; a handover version opens an Execution File. */
async function confirmOrder(w, reviewer) {
  const request = await CustomerRequest.create({
    requestId: `REQ-CL-${w.seq}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${w.seq}` },
    items: [{
      stockItemName: `Polo ${w.seq}`, totalQuantity: 500,
      totalEstimatedPrice: 240, sampleStyleId: w.style._id,
    }],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  const { version, correlationId } = await handoverProducer.issue({ companyId: w.co._id }, {
    requestId: String(request._id), lineId: lineRef,
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity: 500 }],
    },
    actor: { name: "Sales Person" },
  });
  await handoverDelivery.deliverPending({ companyId: w.co._id, correlationId });

  const accepted = await call(`/handovers/${version._id}/accept`, {
    ...at(w, reviewer), method: "POST", body: {},
  });
  return {
    requestId: String(request._id), lineRef,
    handoverRef: `REQ-CL-${w.seq}`,
    fileId: accepted.body?.file?.id,
    acceptStatus: accepted.status,
  };
}

/* ══ THE JOURNEY, IN ORDER ════════════════════════════════════════════════

   ── WHY THIS IS ONE `test` AND NOT ELEVEN ──────────────────────────────────
   `test/setup.js` clears every collection after each test, which is right for
   suites that assert one rule against one fixture and wrong for a chain: the
   whole point here is that step 7 consumes what step 3 approved. Splitting the
   walk into eleven tests would give eleven tests that each rebuild the world
   and prove nothing about the seams between them.

   So it is one walk, in order, with each step's assertions under its own
   heading. A failure names the line, and the line names the step. */

describe("the complete Merchandising journey works as one product", () => {
  test("Sales asks, Merchandising selects, the order adopts, PPC receives", async () => {
    const w = await world();
    const c = await cast(w.co);

    /* ── 1. SALES ISSUES A VERSIONED DEVELOPMENT REQUEST ──────────────── */

    expect(w.productLineRef).toMatch(PRODUCT_LINE_REF_PATTERN);

    const issued = await sdev(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
      ...at(w, c.salesApprover), method: "POST",
      body: {
        requirementSummary: "Navy pique polo, woven neck label, buyer's own button.",
        requestedCategories: ["FABRIC", "TRIMS", "LABELS", "SAMPLE_PACKAGING"],
        requiredByDate: "2026-10-15",
        sampleStyleId: String(w.style._id),
      },
    });
    expect(issued.status).toBe(201);
    expect(issued.body.request.versionNo).toBe(1);
    const requestRef = issued.body.request.requestRef;

    /* Merchandising cannot ask itself. */
    const merchAsks = await sdev(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
      ...at(w, c.owner), method: "POST", body: { requirementSummary: "Mine now." },
    });
    expect(merchAsks.status).toBe(403);

    /* The ask opened a Development File, rooted on the SAME line reference. */
    let devFile = await DevelopmentFile.findOne({
      companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef,
    }).lean();
    expect(devFile).toBeTruthy();
    expect(devFile.lifecycleStatus).toBe(LIFECYCLE.NEW);
    const devFileId = String(devFile._id);

    /* ── 2. MERCHANDISING ACCEPTS AND SELECTS ─────────────────────────── */

    /* A viewer reads and cannot decide. */
    expect((await call(`/development/${devFileId}`, at(w, c.viewer))).status).toBe(200);
    expect((await call(`/development/${devFileId}/accept`, {
      ...at(w, c.viewer), method: "POST", body: { idempotencyKey: uniq() },
    })).status).toBe(403);

    /* A platform administrator with no Merchandising grant reaches nothing. */
    expect((await call(`/development/${devFileId}`, at(w, c.admin))).status).toBe(403);

    expect((await call(`/development/${devFileId}/accept`, {
      ...at(w, c.approver), method: "POST", body: { idempotencyKey: uniq() },
    })).status).toBe(200);

    expect((await call(`/development/${devFileId}/bom`, {
      ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() },
    })).status).toBe(201);

    let bom = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: devFileId, state: BOM_STATE.DRAFT,
    }).lean();

    for (const row of [
      { category: "FABRIC", rawItemName: "Navy pique 220gsm", rawItemSku: "PQ-220",
        colourOrShade: "Navy", finish: "Enzyme wash", placement: "Body" },
      { category: "LABEL", rawItemName: "Woven neck label", colourOrShade: "White",
        placement: "Centre back neck" },
      { category: "SAMPLE_PACKAGING", rawItemName: "Polybag 300x400", placement: "Individual" },
    ]) {
      const added = await call(`/development/${devFileId}/bom/rows`, {
        ...at(w, c.editor), method: "POST",
        body: { ...row, expectedRevision: bom.revision ?? 0 },
      });
      expect(added.status).toBe(201);
      bom = await DevelopmentBomRevision.findById(bom._id).lean();
    }
    expect(bom.rows).toHaveLength(3);

    /* Sales cannot edit what Merchandising selected. */
    const salesEdits = await call(`/development/${devFileId}/bom/rows`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { category: "FABRIC", rawItemName: "Something cheaper",
        expectedRevision: bom.revision ?? 0 },
    });
    expect(salesEdits.status).toBe(403);

    expect((await call(`/development/${devFileId}/bom/submit`, {
      ...at(w, c.editor), method: "POST",
      body: { expectedRevision: bom.revision ?? 0, idempotencyKey: uniq() },
    })).status).toBe(200);

    /* ── 3. A SECOND PERSON APPROVES IT ───────────────────────────────── */

    bom = await DevelopmentBomRevision.findById(bom._id).lean();
    expect(bom.state).toBe(BOM_STATE.SUBMITTED);

    /* The author, who is also the submitter, is refused. */
    const selfApprove = await call(`/development/${devFileId}/bom/approve`, {
      ...at(w, c.editor), method: "POST",
      body: { expectedRevision: bom.revision ?? 0, idempotencyKey: uniq() },
    });
    expect(selfApprove.status).toBeGreaterThanOrEqual(400);

    const approved = await call(`/development/${devFileId}/bom/approve`, {
      ...at(w, c.checker), method: "POST",
      body: { expectedRevision: bom.revision ?? 0, idempotencyKey: uniq() },
    });
    expect(approved.status).toBe(200);

    bom = await DevelopmentBomRevision.findById(bom._id).lean();
    expect(bom.state).toBe(BOM_STATE.APPROVED);
    const bomRevision = bom.revisionNo;

    devFile = await DevelopmentFile.findById(devFileId).lean();
    expect(devFile.lifecycleStatus).toBe(LIFECYCLE.APPROVED);

    /* ── 4. SALES — NOT MERCHANDISING — RELEASES TO R&D ───────────────── */

    /* There is no such route on the Merchandising side at all. */
    expect((await call(`/development/${devFileId}/release`, {
      ...at(w, c.owner), method: "POST", body: {},
    })).status).toBe(404);

    /* The release names the exact approved revision the panel showed. Sales
       authorises a SELECTION, not "whatever this file currently points at" —
       delivery is asynchronous, and without the binding a revision approved
       in the gap would reach R&D unreviewed. */
    const released = await sdev(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { releaseReference: "BUYER-OK-1", expectedBomRevisionNo: bomRevision },
    });
    expect(released.status).toBe(200);
    expect(released.body.bomRevisionNo).toBe(bomRevision);

    devFile = await DevelopmentFile.findById(devFileId).lean();
    expect(devFile.lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect(devFile.releasedBomRevisionNo).toBe(bomRevision);

    /* ── 5. R&D READS THE APPROVED SELECTION FIRST ────────────────────── */

    const shortlist = require("../../services/approvedMaterialShortlist.service");
    const style = await SampleStyle.findById(w.style._id).lean();
    const out = await shortlist.approvedShortlistFor(style);
    /* The identities R&D engineers against are the ones Merchandising
       approved — not the registered product's, and not the old form's. */
    expect(out.source).toBe("DEVELOPMENT_BOM");
    expect(out.developmentBomRevisionNo).toBe(bomRevision);
    expect(JSON.stringify(out.rows)).toMatch(/Navy pique 220gsm/);
    expect(out.blocker).toBeNull();

    /* ── 6. THE BUYER CONFIRMS; A SEPARATE EXECUTION FILE OPENS ───────── */

    const order = await confirmOrder(w, c.approver);
    expect([200, 201]).toContain(order.acceptStatus);
    const orderFileId = order.fileId;
    expect(orderFileId).toBeTruthy();

    /* TWO RECORDS. Neither became the other. */
    expect(String(orderFileId)).not.toBe(String(devFileId));
    expect(await DevelopmentFile.findById(devFileId).lean()).toBeTruthy();
    expect(await ExecutionFile.findById(orderFileId).lean()).toBeTruthy();

    /* ── 7. THE ORDER ADOPTS THE APPROVED SELECTION INTO A DRAFT ──────── */

    const preview = await call(`/files/${orderFileId}/development-bom-adoption/preview`,
      at(w, c.viewer));
    expect(preview.status).toBe(200);
    expect(preview.body.available).toBe(true);
    expect(preview.body.bomRevisionNo).toBe(bomRevision);
    /* The explicit adoption link between the two records. */
    expect(preview.body.developmentNumber).toMatch(/^MDV-/);

    const adopt = await call(`/files/${orderFileId}/development-bom-adoption/adopt`, {
      ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(adopt.status).toBe(200);
    expect(adopt.body.adopted).toBeGreaterThan(0);

    /* NOTHING was approved by adopting. The order's own approver still decides
       — a sample selection is not a factory instruction. */
    const materials = await MaterialTrimRevision.find({
      companyId: w.co._id, fileId: orderFileId,
    }).lean();
    expect(materials.length).toBeGreaterThan(0);
    for (const m of materials) expect(m.state).not.toBe("APPROVED");
    expect(JSON.stringify(materials)).toMatch(/Adopted from development MDV-/);

    /* ── 7b. THE ORDER'S OWN APPROVER SETTLES EACH FAMILY ─────────────
       Adoption filled two drafts and approved neither. This is where the
       order's materials, packaging and development requirements actually
       become the order's — each through the same maker/checker gate, and each
       by somebody who did not write it. */

    /* The M4 development requirement has no pre-order source, so it is stated
       here for the order the way it always was. */
    const devDraft = await call(`/files/${orderFileId}/selections/DEVELOPMENT/revisions`, {
      ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect([200, 201]).toContain(devDraft.status);
    const devRowAdded = await call(`/files/${orderFileId}/selections/DEVELOPMENT/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        requirementType: "PRINT", title: "Chest print artwork",
        responsibleApplication: "PRODUCT_DEVELOPMENT", brief: "Buyer artwork, two colours.",
        requiredByDate: "2026-08-01",
        expectedRevision: devDraft.body?.revision?.revision ?? 0,
      },
    });
    expect(devRowAdded.status).toBe(201);

    for (const family of ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT"]) {
      const current = await call(`/files/${orderFileId}/selections/${family}`, at(w, c.viewer));
      const working = current.body?.working || current.body?.revision;
      const at0 = working?.revision ?? 0;

      const sub = await call(`/files/${orderFileId}/selections/${family}/submit`, {
        ...at(w, c.editor), method: "POST",
        body: { expectedRevision: at0, idempotencyKey: uniq() },
      });
      expect(sub.status).toBe(200);

      /* The author cannot approve their own revision, in this family too. */
      const self = await call(`/files/${orderFileId}/selections/${family}/approve`, {
        ...at(w, c.editor), method: "POST",
        body: { expectedRevision: sub.body?.revision?.revision ?? at0 + 1, idempotencyKey: uniq() },
      });
      expect(self.status).toBeGreaterThanOrEqual(400);

      const ok = await call(`/files/${orderFileId}/selections/${family}/approve`, {
        ...at(w, c.checker), method: "POST",
        body: { expectedRevision: sub.body?.revision?.revision ?? at0 + 1, idempotencyKey: uniq() },
      });
      expect(ok.status).toBe(200);
    }

    /* ── 8. TIME & ACTION CONTROLS THE ORDER'S DATES ──────────────────── */

    await process_(w, c.owner);
    const plan = await call(`/files/${orderFileId}/tna`, {
      ...at(w, c.approver), method: "POST",
      body: { planStartDate: "2026-06-01", idempotencyKey: uniq() },
    });
    expect(plan.status).toBe(201);

    const readPlan = await call(`/files/${orderFileId}/tna`, at(w, c.viewer));
    expect(readPlan.status).toBe(200);
    expect(readPlan.body.milestones.length).toBeGreaterThan(0);

    const baselined = await call(`/files/${orderFileId}/tna/baseline/approve`, {
      ...at(w, c.approver), method: "POST",
      body: { expectedRevision: readPlan.body.plan.revision ?? 0, idempotencyKey: uniq() },
    });
    expect(baselined.status).toBe(200);

    /* ── 8b. ONE DATE MOVES, DECIDED BY SOMEBODY ELSE ─────────────────
       The whole point of the maker/checker rule on reschedules, exercised
       with two real people rather than asserted about one. */

    const planNow = await call(`/files/${orderFileId}/tna`, at(w, c.viewer));
    /* A milestone that is still OPEN. `TRIM_APPROVED` has already been closed
       by the material-trim approval above — its completion authority is that
       department's own event — and a finished date is not one you reschedule. */
    const firstMilestone = planNow.body.milestones
      .find((m) => !m.actualDate && m.status !== "COMPLETE");
    expect(firstMilestone).toBeTruthy();

    await call("/tna/reason-codes", {
      ...at(w, c.owner), method: "POST",
      body: { code: "SUPPLIER_LATE", label: "Supplier late", kind: "RESCHEDULE" },
    });

    const proposed = await call(`/files/${orderFileId}/tna/reschedule/preview`, {
      ...at(w, c.editor), method: "POST",
      body: {
        milestoneRef: firstMilestone.milestoneRef,
        proposedDate: "2026-07-20",
        reasonCode: "SUPPLIER_LATE",
        reasonNote: "The mill confirmed a two week delay on the pique.",
      },
    });
    expect(proposed.status).toBe(200);
    const rescheduleRef = proposed.body.reschedule.rescheduleRef;

    /* The person who asked cannot decide it. */
    const selfDecide = await call(
      `/files/${orderFileId}/tna/reschedule/${rescheduleRef}/approve`,
      { ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() } },
    );
    expect(selfDecide.status).toBeGreaterThanOrEqual(400);

    /* It is waiting, and a second person can find it. */
    const waiting = await call(
      `/files/${orderFileId}/tna/reschedules?state=PREVIEWED`, at(w, c.checker));
    expect(waiting.status).toBe(200);
    expect(waiting.body.reschedules.map((r) => r.rescheduleRef)).toContain(rescheduleRef);

    const decided = await call(
      `/files/${orderFileId}/tna/reschedule/${rescheduleRef}/approve`,
      { ...at(w, c.checker), method: "POST", body: { idempotencyKey: uniq() } },
    );
    expect(decided.status).toBe(200);

    const movedPlan = await call(`/files/${orderFileId}/tna`, at(w, c.viewer));
    const moved = movedPlan.body.milestones
      .find((m) => m.milestoneRef === firstMilestone.milestoneRef);
    expect(String(moved.forecastDate).slice(0, 10)).toBe("2026-07-20");

    /* ── AND THE COMMITMENT WAS RE-MADE, NOT QUIETLY EDITED ───────────
       This move pushes the order past a committed delivery date, so approving
       it writes a NEW baseline revision and keeps the one it replaced. That is
       the difference between rescheduling and rewriting history. */
    const baselines = await call(`/files/${orderFileId}/tna/baselines`, at(w, c.viewer));
    expect(baselines.status).toBe(200);
    expect(baselines.body.baselines.length).toBeGreaterThan(1);
    const active = baselines.body.baselines.filter((b) => b.state === "ACTIVE");
    expect(active).toHaveLength(1);
    const superseded = baselines.body.baselines.filter((b) => b.state === "SUPERSEDED");
    expect(superseded.length).toBeGreaterThan(0);

    /* ── 9. THE EXECUTION PACK GOES DOWNSTREAM ────────────────────────── */

    const built = await call(`/files/${orderFileId}/pack`, {
      ...at(w, c.approver), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect([200, 201]).toContain(built.status);

    /* Submitting states that Merchandising's own work is complete, and the
       server refuses to take that statement implicitly — a person acknowledges
       it or nothing is sent. */
    const packRead = await call(`/files/${orderFileId}/pack`, at(w, c.viewer));
    const packRevision = packRead.body?.pack?.revision ?? 0;

    const unacknowledged = await call(`/files/${orderFileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST",
      body: { expectedRevision: packRevision, idempotencyKey: uniq() },
    });
    expect(unacknowledged.status).toBe(400);

    const submitted = await call(`/files/${orderFileId}/pack/submit`, {
      ...at(w, c.approver), method: "POST",
      body: {
        declarationAcknowledged: true,
        expectedRevision: packRevision,
        idempotencyKey: uniq(),
      },
    });
    expect(submitted.status).toBe(200);

    /* Merchandising cannot accept on PPC's behalf: the file is not handed over
       until PPC's own receiver says so. */
    const afterSubmit = await ExecutionFile.findById(orderFileId).lean();
    expect(afterSubmit.lifecycleStatus).not.toBe("HANDED_OVER");

    /* ── 10. NOTHING EARLIER IS EVER OVERWRITTEN ──────────────────────── */

    const revisionsBefore = await DevelopmentBomRevision.find({
      companyId: w.co._id, developmentFileId: devFileId,
    }).sort({ revisionNo: 1 }).lean();

    const packBefore = await call(`/files/${orderFileId}/pack`, at(w, c.viewer));
    const packBeforeChange = packBefore.body?.pack?.packVersionNo;
    expect(typeof packBeforeChange).toBe("number");

    const materialsBefore = await MaterialTrimRevision.find({
      companyId: w.co._id, fileId: orderFileId, state: "APPROVED",
    }).lean();
    expect(materialsBefore.length).toBeGreaterThan(0);

    const notice = await schange(`/requests/${order.requestId}/lines/${order.lineRef}`, {
      ...at(w, c.salesApprover), method: "POST",
      body: {
        changeKind: "DELIVERY_DATE",
        reason: "The buyer moved the second drop out by two weeks.",
        /* A change carries the WHOLE projection, not the fields that moved —
           `before` is read server-side from the accepted handover, so a
           merchandiser compares a fact against a claim rather than two claims. */
        after: {
          orderRef: order.handoverRef,
          orderLineRef: order.lineRef,
          styleRef: `SC-CL-${w.seq}`,
          productName: `Polo ${w.seq}`,
          buyerDisplayLabel: `Buyer ${w.seq}`,
          totalQuantity: 500,
          deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-15", quantity: 500 }],
        },
      },
    });
    expect([200, 201]).toContain(notice.status);

    /* ── A NEW REVISION, NOT AN EDIT ──────────────────────────────────
       The order's approved selection is the thing a factory works from. A
       change to the commercial requirement must not reach back into it: the
       approved revision stays exactly as approved, and any new decision is a
       new revision beside it. */
    const materialsAfter = await MaterialTrimRevision.find({
      companyId: w.co._id, fileId: orderFileId, state: "APPROVED",
    }).lean();
    expect(materialsAfter).toHaveLength(materialsBefore.length);
    expect(JSON.stringify(materialsAfter.map((m) => m.rows)))
      .toBe(JSON.stringify(materialsBefore.map((m) => m.rows)));

    /* And the pack that went downstream is still the version PPC received —
       a change to the commercial requirement does not silently reissue it. */
    const packAfter = await call(`/files/${orderFileId}/pack`, at(w, c.viewer));
    expect(packAfter.status).toBe(200);
    expect(packAfter.body.pack.packVersionNo).toBe(packBeforeChange);

    const revisionsAfter = await DevelopmentBomRevision.find({
      companyId: w.co._id, developmentFileId: devFileId,
    }).sort({ revisionNo: 1 }).lean();
    expect(revisionsAfter).toHaveLength(revisionsBefore.length);
    const stillApproved = revisionsAfter.find((r) => r.state === BOM_STATE.APPROVED);
    expect(stillApproved.revisionNo).toBe(bomRevision);
    expect(JSON.stringify(stillApproved.rows)).toBe(
      JSON.stringify(revisionsBefore.find((r) => r.state === BOM_STATE.APPROVED).rows),
    );

    /* ── 11. AND THE CHAIN READS FROM BOTH ENDS ───────────────────────── */

    const salesView = await sdev(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    expect(salesView.status).toBe(200);
    const line = salesView.body.merchandising[w.productLineRef];
    expect(line.approvedRevisionNo).toBe(bomRevision);
    expect(line.selectedMaterials.length).toBeGreaterThan(0);
    expect(line.releasedToRndAt).toBeTruthy();
    /* Sales holds a statement, never a handle. */
    expect(line).not.toHaveProperty("developmentFileId");

    const history = await call(`/files/${orderFileId}/history`, at(w, c.viewer));
    expect(history.status).toBe(200);
    /* The audit trail survived the fileId defect: it holds this file's own
       events, not just its handover lineage. */
    expect(Array.isArray(history.body.events)).toBe(true);
    expect(history.body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(history.body.events)).toMatch(/FILE_CREATED/);
  }, 120000);
});
