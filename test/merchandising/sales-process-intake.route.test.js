// test/merchandising/sales-process-intake.route.test.js
//
// WHAT SALES CONFIRMED BECOMES WORK SOMEBODY REVIEWED — NOT WORK SOMEBODY
// INVENTED, AND NEVER WORK THE SYSTEM DECIDED ON A DEPARTMENT'S BEHALF.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// A merchandiser opening a fresh order faced an empty Development Requirements
// list. The buyer's confirmed embroidery, printing and washing requirements sat in
// an immutable Sales version three tabs away; nothing proposed them, nothing
// checked the list against them, and the demo's six beautifully-worded rows were
// one person's translation of a product story. So the screen looked complete and
// the workflow could not produce it.
//
// What this suite holds:
//
//   1  REQUIRED becomes a suggestion; NOT_REQUIRED becomes a stated fact with no
//      work item; UNKNOWN and never-answered become an information GAP. The last
//      one matters most — "Sales has not said" and "Sales said no" are different
//      facts, and collapsing them is how an order ships without the embroidery the
//      buyer assumed.
//   2  A suggestion invents no owner, no date, no status and no progress. Adoption
//      refuses to proceed without the two answers only a person can give.
//   3  Adoption records an IMMUTABLE Sales source reference the browser cannot
//      forge, because `sourceRef` is not a body field anywhere in this flow.
//   4  Replaying adoption creates no duplicate — by key and, more importantly, by
//      name.
//   5  Reconciliation is computed by the SERVER from both records, and blocks
//      submission for a required-but-missing process, a superseded statement and an
//      unjustified conflict — never for an unstated one.
//   6  Approval keeps its maker/checker separation, untouched.
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
  DevelopmentRevision, REVISION_STATE,
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
  await mongoose.connect(rs.getUri(), { dbName: "sales_process_intake" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  /* The partial unique indexes are the invariant under test, so they must
     actually exist rather than be created lazily. */
  await DevelopmentRevision.syncIndexes();
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
  const email = `spi-${n}@grav.test`;
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
 * A company with an accepted handover whose Sales version STATES the buyer's
 * processes — issued through the real producer, accepted through the real
 * acceptance, because a fixture that wrote the version directly would prove
 * nothing about the flow under test.
 */
async function world(label = "SPI", {
  processes = null, quantity = 400, split = false, developmentFiles = 0,
} = {}) {
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
    stage: "rnd", materials: { status: "selected", rawItems: [] },
  });

  /* ── A COMPANY ORDER, SO SALES' OWN AUTHORISATION IS THE EVIDENCE ────────
     A definite process answer must cite an authority. A buyer PO would need an
     uploaded document fixture; an internal order carries Sales' own approval,
     which is a real authority in this contract and keeps the fixture about the
     thing under test. */
  const approverId = new mongoose.Types.ObjectId();
  const request = await CustomerRequest.create({
    /* `orderOrigin` stays "customer" — only a customer order may be handed over —
       while `isInternalOrder` is what makes Sales' own approval an authority a
       definite process answer may cite. The two are different questions. */
    requestId: `REQ-${label}-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    isInternalOrder: true, internalOrderMarkedAt: new Date("2026-09-01"),
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: `${label} polo`, totalQuantity: quantity,
      totalEstimatedPrice: 240, sampleStyleId: style._id,
      /* A quotation ROW has no `lineRef`, so the authority-covers-this-line rule
         joins on the product line instead — one row on the round, one item on the
         order. Both sides must therefore carry it. */
      productLineRef: `PL-${label}-${n}`,
    }],
    quotations: [{
      revision: 1, status: "sales_approved", date: new Date("2026-09-01"),
      salesApproval: { approvedBy: approverId, approvedAt: new Date("2026-09-02") },
      /* The round must COVER the line, or it is not an authority for it. */
      items: [{
        productLineRef: `PL-${label}-${n}`, itemName: `${label} polo`,
        quantity, sampleStyleId: style._id,
      }],
    }],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  const quotationId = String(saved.quotations[0]._id);
  const evidenceRef = `INTERNAL_ORDER:${quotationId}:r1`;

  const deliveries = split
    ? [
      { dropRef: "D1", committedDeliveryDate: "2026-11-01", quantity: quantity / 2 },
      { dropRef: "D2", committedDeliveryDate: "2026-12-01", quantity: quantity / 2 },
    ]
    : [{ dropRef: "D1", committedDeliveryDate: "2026-11-01", quantity }];

  const body = { expectedCurrentVersionNo: 0, deliveries };
  if (split) {
    body.breakdown = [
      { lineSplitRef: "S1", quantity: quantity / 2, attributes: [{ name: "Colour", value: "Navy" }] },
      { lineSplitRef: "S2", quantity: quantity / 2, attributes: [{ name: "Colour", value: "White" }] },
    ];
    body.allocations = [
      { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: quantity / 2 },
      { allocationRef: "A2", lineSplitRef: "S2", dropRef: "D2", quantity: quantity / 2 },
    ];
  }
  if (processes) {
    /* ── THE SALES CONTRACT ALREADY REFUSES A PARTIAL STATEMENT ────────────
       "State printing, washing as well — silence is never 'not required'." So a
       version either states all three core processes or states none, and the
       shape silence takes is an explicit UNKNOWN. The fixture fills the ones a
       test did not name, which is what the real form makes a salesperson do. */
    const named = new Set(processes.map((p) => p.process));
    const all = [
      ...processes,
      ...["EMBROIDERY", "PRINTING", "WASHING"]
        .filter((x) => !named.has(x))
        .map((x) => ({ process: x, requirement: "UNKNOWN" })),
    ];
    body.processRequirements = {
      processes: all.map((p) => ({
        process: p.process,
        requirement: p.requirement,
        ...(p.requirement === "REQUIRED" || p.requirement === "NOT_REQUIRED"
          ? {
            evidenceRef,
            /* A definite answer must say what was decided — required on this
               contract, so the fixture always states one. */
            buyerSpecification: p.buyerSpecification
              || (p.requirement === "REQUIRED" ? "As the buyer specified." : "Not part of this order."),
            authorisationReason: "Company uniform order; processes decided in-house.",
          }
          : {}),
      })),
    };
  }

  /* ── A DEVELOPMENT RECORD, BEFORE ACCEPTANCE ──────────────────────────────
     So the link can be resolved and stamped by the acceptance itself, which is
     where that decision belongs. */
  const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");
  const devFiles = [];
  for (let i = 0; i < developmentFiles; i += 1) {
    devFiles.push(await DevelopmentFile.create({
      companyId: co._id,
      developmentNumber: `DEV-${label}-${n}-${i + 1}`,
      productName: `${label} polo`, styleRef: `SC-${label}-${n}`,
      sampleStyleId: style._id, journeyId: journey._id,
      /* The first is THIS order line's; a second is another product line that
         happens to have selected the same style — legitimate, and the reason
         `sampleStyleId` alone is not an identity. */
      productLineRef: i === 0 ? `PL-${label}-${n}` : `PL-${label}-${n}-other-${i}`,
    }));
  }

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(request._id), lineId: lineRef, body,
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const reviewer = await actor({ companies: [co], grants: { merchandiser: "approver" } });
  const accepted = await execution.acceptHandover(
    { companyId: co._id },
    { id: String(version._id), actor: { name: reviewer.name, email: reviewer.email } },
  );
  const units = await ExecutionUnit.find({ fileId: accepted.file.id }).lean();

  return {
    co, style, journey, request, lineRef, version, evidenceRef, quotationId, devFiles,
    fileId: String(accepted.file.id),
    unitRefs: units.map((u) => u.unitDiscriminator),
  };
}

const cast = async (co) => ({
  viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
  editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
  approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
  approver2: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
});

const at = (w, who) => ({ token: who.token, company: w.co._id });
const intake = (w, who) => call(`/files/${w.fileId}/sales-process-intake`, at(w, who));
const reconcile = (w, who) => call(`/files/${w.fileId}/sales-process-reconciliation`, at(w, who));
const adopt = (w, who, decisions, key = uniq()) =>
  call(`/files/${w.fileId}/sales-process-intake/adopt`, {
    ...at(w, who), method: "POST", key, body: { decisions },
  });
const devRevision = (w, who) => call(`/files/${w.fileId}/selections/DEVELOPMENT`, at(w, who));

/** Submit the development draft, naming the revision being advanced. */
async function submitDev(w, who) {
  const rev = (await devRevision(w, who)).body.working;
  return call(`/files/${w.fileId}/selections/DEVELOPMENT/submit`, {
    ...at(w, who), method: "POST", key: uniq(), body: { expectedRevision: rev?.revision },
  });
}

/** Approve it, as a second person. */
async function approveDev(w, who) {
  const rev = (await devRevision(w, who)).body.working;
  return call(`/files/${w.fileId}/selections/DEVELOPMENT/approve`, {
    ...at(w, who), method: "POST", key: uniq(), body: { expectedRevision: rev?.revision },
  });
}

/** An open draft with one unrelated row, so a block is about Sales and not emptiness. */
async function draftWith(w, who, row) {
  await call(`/files/${w.fileId}/selections/DEVELOPMENT/revisions`, {
    ...at(w, who), method: "POST", key: uniq(), body: {},
  });
  const rev = (await devRevision(w, who)).body.working;
  return call(`/files/${w.fileId}/selections/DEVELOPMENT/rows`, {
    ...at(w, who), method: "POST", key: uniq(),
    body: { ...row, expectedRevision: rev?.revision },
  });
}

const DECIDED = {
  responsibleApplication: "PRODUCT_DEVELOPMENT",
  requiredByDate: "2026-10-20",
};

/* ══ 1 · WHAT SALES SAID BECOMES A SUGGESTION, A STATEMENT OR A GAP ═══════ */

describe("reading the buyer's confirmed processes", () => {
  test("REQUIRED becomes a suggestion carrying the buyer's own words and authority", async () => {
    const w = await world("REQ", {
      processes: [
        { process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Left chest logo, 3 colours" },
        { process: "PRINTING", requirement: "NOT_REQUIRED" },
        { process: "WASHING", requirement: "REQUIRED", buyerSpecification: "Enzyme wash, soft hand" },
      ],
    });
    const c = await cast(w.co);
    const res = await intake(w, c.editor);

    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((s) => s.process).sort()).toEqual(["EMBROIDERY", "WASHING"]);

    const emb = res.body.suggestions.find((s) => s.process === "EMBROIDERY");
    /* Sales' vocabulary is EMBROIDERY/PRINTING/WASHING; a requirement's is
       EMBROIDERY/PRINT/WASH. The translation is the service's, in one place. */
    expect(emb.requirementType).toBe("EMBROIDERY");
    expect(emb.brief).toContain("Left chest logo, 3 colours");
    expect(emb.handoverVersionNo).toBe(1);
    /* On whose authority the buyer requirement rests. */
    expect(emb.salesAuthority.kind).toBe("INTERNAL_ORDER");

    const wash = res.body.suggestions.find((s) => s.process === "WASHING");
    expect(wash.requirementType).toBe("WASH");
  });

  test("a suggestion decides nothing a person or a department owns", async () => {
    const w = await world("NODE", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Crest" }],
    });
    const c = await cast(w.co);
    const s = (await intake(w, c.editor)).body.suggestions[0];

    /* The absences are the point. A proposal that filled these in would be this
       service quietly doing four other departments' jobs and signing their names. */
    for (const invented of [
      "responsibleApplication", "requiredByDate", "status", "progress",
      "approvedReference", "supplier", "cost", "consumption", "completedAt",
    ]) {
      expect(s[invented]).toBeUndefined();
    }
    /* And it says so, so a screen renders inputs rather than blanks somebody
       might read as "none". */
    expect(s.decidesNothingAbout).toEqual(expect.arrayContaining([
      "responsibleApplication", "requiredByDate", "progress",
    ]));
  });

  test("NOT_REQUIRED is a stated fact with no actionable work item", async () => {
    const w = await world("NOT", {
      processes: [{ process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "Plain body" }],
    });
    const c = await cast(w.co);
    const res = await intake(w, c.editor);

    expect(res.body.suggestions.find((s) => s.process === "PRINTING")).toBeUndefined();
    const said = res.body.statements.find((s) => s.process === "PRINTING");
    expect(said.requirement).toBe("NOT_REQUIRED");
    expect(said.actionable).toBe(false);
    expect(said.words).toMatch(/not required/i);
  });

  test("UNKNOWN is an information gap, and never becomes 'not required'", async () => {
    /* The distinction this whole service exists to keep: an order that ships
       without the embroidery the buyer assumed is what collapsing them looks like. */
    const w = await world("UNK", {
      processes: [
        { process: "EMBROIDERY", requirement: "UNKNOWN" },
        { process: "PRINTING", requirement: "NOT_REQUIRED" },
      ],
    });
    const c = await cast(w.co);
    const res = await intake(w, c.editor);

    const gap = res.body.gaps.find((g) => g.process === "EMBROIDERY");
    expect(gap).toBeTruthy();
    expect(gap.askSales).toBe(true);
    expect(res.body.statements.find((s) => s.process === "EMBROIDERY")).toBeUndefined();
    expect(res.body.suggestions.find((s) => s.process === "EMBROIDERY")).toBeUndefined();
  });

  test("the shape silence takes is UNKNOWN, and it reads as a gap", async () => {
    /* Sales cannot state one process and leave the others out — the producer
       refuses it, in as many words: "silence is never 'not required'". So the only
       unanswered state that can reach Merchandising is an explicit UNKNOWN, and it
       arrives as a gap rather than as an absence nobody notices. */
    const w = await world("SILENT", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Crest" }],
    });
    const c = await cast(w.co);
    const res = await intake(w, c.editor);

    expect(res.body.gaps.map((g) => g.process).sort()).toEqual(["PRINTING", "WASHING"]);
    for (const g of res.body.gaps) {
      expect(g.words).toMatch(/has not stated|unknown/i);
      expect(g.askSales).toBe(true);
    }
  });

  test("a version stating nothing at all leaves three gaps and no suggestions", async () => {
    const w = await world("NONE");
    const c = await cast(w.co);
    const res = await intake(w, c.editor);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.gaps).toHaveLength(3);
  });

  test("applicability is offered only where Sales stated enough to know", async () => {
    const one = await world("ONE", {
      processes: [{ process: "WASHING", requirement: "REQUIRED" }],
    });
    const c1 = await cast(one.co);
    const single = (await intake(one, c1.editor)).body.suggestions[0];
    expect(single.applicability).toMatchObject({ appliesToAllUnits: true, resolved: true });

    /* Four units and a statement that names none of them: genuinely unresolved.
       Guessing "all units" would commit units nobody asked for. */
    const many = await world("MANY", {
      split: true,
      processes: [{ process: "WASHING", requirement: "REQUIRED" }],
    });
    const c2 = await cast(many.co);
    const multi = (await intake(many, c2.editor)).body.suggestions[0];
    expect(multi.applicability.resolved).toBe(false);
  });

  test("a viewer may read the suggestions and cannot adopt them", async () => {
    const w = await world("AUTH", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    expect((await intake(w, c.viewer)).status).toBe(200);
    const s = (await intake(w, c.editor)).body.suggestions[0];
    const res = await adopt(w, c.viewer, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);
    expect(res.status).toBe(403);
  });

  test("another company's file reads exactly like one that does not exist", async () => {
    const mine = await world("MINE", { processes: [{ process: "WASHING", requirement: "REQUIRED" }] });
    const theirs = await world("THEIRS", { processes: [{ process: "WASHING", requirement: "REQUIRED" }] });
    const c = await cast(mine.co);
    const res = await call(`/files/${theirs.fileId}/sales-process-intake`, at(mine, c.editor));
    expect(res.status).toBe(404);
  });
});

/* ══ 2 · ADOPTION IS A DECISION, TAKEN BY A PERSON ════════════════════════ */

describe("adopting a suggestion", () => {
  const suggestionFor = async (w, who, process) =>
    (await intake(w, who)).body.suggestions.find((s) => s.process === process);

  test("refuses without an owner, and says why nothing guesses one", async () => {
    const w = await world("OWNER", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");

    const res = await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, requiredByDate: "2026-10-20" }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.field).toBe("responsibleApplication");
    expect(res.body.error.message).toMatch(/sentence in a list/);
  });

  test("refuses without a date, for the same reason", async () => {
    const w = await world("DATE", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");

    const res = await adopt(w, c.editor, [{
      suggestionRef: s.suggestionRef, responsibleApplication: "PRODUCT_DEVELOPMENT",
    }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.field).toBe("requiredByDate");
    expect(res.body.error.message).toMatch(/nobody is working to/);
  });

  test("adds a row to a DRAFT, approving nothing", async () => {
    const w = await world("ADD", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Crest, 2 colours" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");

    const res = await adopt(w, c.editor, [{
      suggestionRef: s.suggestionRef, ...DECIDED,
      coordinationNote: "Artwork from the buyer expected next week.",
    }]);
    expect(res.status).toBe(201);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.note).toMatch(/Nothing is approved/i);

    const rev = (await devRevision(w, c.editor)).body;
    expect(rev.working.state).toBe("DRAFT");
    const row = rev.working.rows[0];
    expect(row.requirementType).toBe("EMBROIDERY");
    expect(row.responsibleApplication).toBe("PRODUCT_DEVELOPMENT");
    expect(row.brief).toContain("Crest, 2 colours");
    /* A coordination note is Merchandising's own note — never a department's
       progress. */
    expect(row.coordinationNote).toMatch(/Artwork from the buyer/);
  });

  test("records an immutable Sales source reference the browser never sent", async () => {
    const w = await world("SRC", {
      processes: [{ process: "WASHING", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "WASHING");
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);

    const stored = await DevelopmentRevision.findOne({ companyId: w.co._id, fileId: w.fileId }).lean();
    const row = stored.rows[0];
    expect(row.sourceRef).toMatchObject({
      app: "sales",
      recordType: "handover_version",
      sourceVersion: "1",
      sourceState: "CURRENT",
    });
    /* The exact version, by id — so a reader can go to the statement itself. */
    expect(String(row.sourceRef.recordId)).toBe(String(w.version._id));
    expect(row.sourceRef.recordRef).toContain("#WASHING");
  });

  test("a forged source reference in the body is refused outright", async () => {
    /* The one claim nobody downstream would think to question: "the buyer
       approved this". `sourceRef` is not a body field anywhere in this flow. */
    const w = await world("FORGE", {
      processes: [{ process: "WASHING", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "WASHING");

    const res = await adopt(w, c.editor, [{
      suggestionRef: s.suggestionRef, ...DECIDED,
      sourceRef: { app: "sales", recordType: "handover_version", sourceVersion: "99" },
    }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.field).toBe("sourceRef");
    expect(await DevelopmentRevision.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a suggestion this order's Sales statement does not imply is refused", async () => {
    /* Printing is NOT required here, so there is no printing suggestion to adopt —
       and naming one anyway must not create a requirement. */
    const w = await world("INVENT", {
      processes: [
        { process: "EMBROIDERY", requirement: "REQUIRED" },
        { process: "PRINTING", requirement: "NOT_REQUIRED" },
      ],
    });
    const c = await cast(w.co);
    const res = await adopt(w, c.editor, [{ suggestionRef: "SPS-PRINTING", ...DECIDED }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.field).toBe("suggestionRef");
    expect(await DevelopmentRevision.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("replaying the same adoption creates no duplicate", async () => {
    const w = await world("REPLAY", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");
    const key = uniq();
    const decisions = [{ suggestionRef: s.suggestionRef, ...DECIDED }];

    const first = await adopt(w, c.editor, decisions, key);
    const again = await adopt(w, c.editor, decisions, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);

    const stored = await DevelopmentRevision.findOne({ companyId: w.co._id, fileId: w.fileId }).lean();
    expect(stored.rows).toHaveLength(1);
  });

  test("and a SECOND adoption with a fresh key still creates no duplicate", async () => {
    /* The realistic double-click: a new key, the same intention. Skipped by NAME,
       because the caller's intent — "this order should have embroidery
       development" — is already satisfied. */
    const w = await world("TWICE", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);
    const second = await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);

    expect(second.status).toBe(201);
    expect(second.body.added).toEqual([]);
    expect(second.body.skipped[0].reason).toBe("ALREADY_IN_DRAFT");

    const stored = await DevelopmentRevision.findOne({ companyId: w.co._id, fileId: w.fileId }).lean();
    expect(stored.rows).toHaveLength(1);
  });

  test("an adopted process stops being suggested and becomes a covered statement", async () => {
    const w = await world("COVER", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = await suggestionFor(w, c.editor, "EMBROIDERY");
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);

    const after = (await intake(w, c.editor)).body;
    expect(after.suggestions).toEqual([]);
    const covered = after.statements.find((x) => x.process === "EMBROIDERY");
    expect(covered.standing).toBe("ALREADY_COVERED");
    expect(covered.coveredBy[0].requirementRef).toMatch(/^/);
  });
});

/* ══ 3 · RECONCILIATION, COMPUTED BY THE SERVER ═══════════════════════════ */

describe("reconciling Sales against the requirement revision", () => {
  test("a required process with no row is reported and blocks submission", async () => {
    const w = await world("MISS", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Crest" }],
    });
    const c = await cast(w.co);

    /* A draft with unrelated work in it — so the block is about the missing
       embroidery, not about an empty revision. */
    const seeded = await draftWith(w, c.editor, {
      requirementType: "FIT_SAMPLE", title: "Fit sample", requiredByDate: "2026-10-10",
      responsibleApplication: "PRODUCT_DEVELOPMENT",
    });
    expect(seeded.status).toBe(201);

    const rec = await reconcile(w, c.editor);
    const found = rec.body.findings.find((f) => f.process === "EMBROIDERY");
    expect(found.state).toBe("REQUIRED_BUT_MISSING");
    expect(found.blocking).toBe(true);
    expect(found.detail).toContain("Crest");
    expect(rec.body.maySubmit).toBe(false);

    const submit = await submitDev(w, c.editor);
    expect(submit.status).toBeGreaterThanOrEqual(400);
    expect(submit.body.error.details.reason).toBe("SALES_RECONCILIATION_BLOCKED");
    /* And it names the process, so the person knows what to add. */
    expect(submit.body.error.details.findings[0].process).toBe("EMBROIDERY");
  });

  test("adopting the missing requirement unblocks it", async () => {
    const w = await world("FIX", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = (await intake(w, c.editor)).body.suggestions[0];
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);

    const rec = await reconcile(w, c.editor);
    expect(rec.body.maySubmit).toBe(true);
    expect(rec.body.findings.find((f) => f.process === "EMBROIDERY").state).toBe("COVERED");

    const submit = await submitDev(w, c.editor);
    expect(submit.status).toBe(200);
  });

  test("an unstated process is reported and NEVER blocks", async () => {
    /* Blocking here would teach people to write a row just to clear the gate. */
    const w = await world("GAP", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const s = (await intake(w, c.editor)).body.suggestions[0];
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);

    const rec = await reconcile(w, c.editor);
    const printing = rec.body.findings.find((f) => f.process === "PRINTING");
    expect(printing.state).toBe("NOT_STATED");
    expect(printing.blocking).toBe(false);
    expect(rec.body.maySubmit).toBe(true);
  });

  test("a superseded Sales statement behind an adopted row is detected and blocks", async () => {
    const w = await world("SUP", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Crest" }],
    });
    const c = await cast(w.co);
    const s = (await intake(w, c.editor)).body.suggestions[0];
    await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);
    expect((await reconcile(w, c.editor)).body.maySubmit).toBe(true);

    /* Sales issues a corrected version — a real one, through the real producer,
       restating the process as the contract requires. */
    const { version: v2, correlationId } = await producer.issue({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineRef,
      body: {
        expectedCurrentVersionNo: 1,
        deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-11-15", quantity: 400 }],
        /* All three core processes again — the producer refuses a partial
           statement, which is the rule that makes silence impossible. */
        processRequirements: {
          processes: [
            {
              process: "EMBROIDERY", requirement: "REQUIRED", evidenceRef: w.evidenceRef,
              buyerSpecification: "Crest moved to the sleeve",
              authorisationReason: "Company uniform order; processes decided in-house.",
            },
            { process: "PRINTING", requirement: "UNKNOWN" },
            { process: "WASHING", requirement: "UNKNOWN" },
          ],
        },
      },
      actor: { name: "Sales Person" },
    });
    await delivery.deliverPending({ companyId: w.co._id, correlationId });
    /* Accepted, so the file now holds version 2. */
    await execution.acceptHandover({ companyId: w.co._id },
      { id: String(v2._id), actor: { name: c.approver.name, email: c.approver.email } });

    const rec = await reconcile(w, c.editor);
    const found = rec.body.findings.find((f) => f.process === "EMBROIDERY");
    expect(found.state).toBe("SALES_STATEMENT_CHANGED");
    expect(found.blocking).toBe(true);
    expect(found.detail).toMatch(/version 1/);
    expect(rec.body.maySubmit).toBe(false);
  });

  test("NOT_REQUIRED with work in the list is a conflict, and a recorded reason clears it", async () => {
    const w = await world("CONFLICT", {
      processes: [{ process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "Plain body" }],
    });
    const c = await cast(w.co);

    const added = await draftWith(w, c.editor, {
      requirementType: "PRINT", title: "Print screen", requiredByDate: "2026-10-10",
      responsibleApplication: "PRODUCT_DEVELOPMENT",
    });
    expect(added.status).toBe(201);

    const rec = await reconcile(w, c.editor);
    const found = rec.body.findings.find((f) => f.process === "PRINTING");
    expect(found.state).toBe("CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS");
    expect(found.blocking).toBe(true);
    expect(found.detail).toMatch(/record on the row why it stands/);

    /* The merchandiser records why it stands — a justified exception, on the row. */
    const rev = (await devRevision(w, c.editor)).body.working;
    const row = rev.rows[0];
    const patched = await call(
      `/files/${w.fileId}/selections/DEVELOPMENT/rows/${row.requirementRef || row.rowRef}`,
      {
        ...at(w, c.editor), method: "PATCH", key: uniq(),
        body: {
          /* A PATCH restates the row, so the fields that make it a valid
             requirement travel with the note. */
          requirementType: row.requirementType,
          title: row.title,
          requiredByDate: row.requiredByDate,
          responsibleApplication: row.responsibleApplication,
          coordinationNote: "Buyer dropped the print after the screen was already cut; "
            + "kept so the cost is recorded against this order.",
          expectedRevision: rev.revision,
        },
      },
    );
    expect(patched.status).toBe(200);

    const after = await reconcile(w, c.editor);
    const cleared = after.body.findings.find((f) => f.process === "PRINTING");
    expect(cleared.blocking).toBe(false);
    expect(after.body.maySubmit).toBe(true);
  });

  test("reconciliation is the server's, and the same answer the block uses", async () => {
    /* Not a React calculation: the claim decides whether a revision may be
       submitted, so it is computed once, from both records, by the side that owns
       the decision. */
    const w = await world("SERVER", {
      processes: [{ process: "WASHING", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);
    const rec = await reconcile(w, c.viewer);
    expect(rec.status).toBe(200);
    expect(rec.body.findings).toHaveLength(3);
    for (const f of rec.body.findings) {
      /* Every finding reads as a sentence, never as a code. */
      expect(f.words.length).toBeGreaterThan(10);
    }
  });
});

/* ══ 4 · NOTHING ABOUT THIS WEAKENS APPROVAL ══════════════════════════════ */

test("an adopted requirement still needs a second person to approve it", async () => {
  const w = await world("MAKER", {
    processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
  });
  const c = await cast(w.co);
  const s = (await intake(w, c.editor)).body.suggestions[0];
  await adopt(w, c.editor, [{ suggestionRef: s.suggestionRef, ...DECIDED }]);
  expect((await submitDev(w, c.editor)).status).toBe(200);

  /* The person who wrote it cannot approve it — adoption changed nothing about
     that, which is the point of checking. */
  const self = await approveDev(w, c.editor);
  expect(self.status).toBeGreaterThanOrEqual(400);

  const other = await approveDev(w, c.approver);
  expect(other.status).toBe(200);
  expect(other.body.revision.state).toBe("APPROVED");
});

/* ══ 5 · THE DEVELOPMENT LINK IS DECIDED AT ACCEPTANCE ════════════════════ */

// It used to be decided by whoever READ the order first — opening the file or
// refreshing its images resolved the lineage and wrote it, with the failure
// swallowed by `.catch(() => {})`. Two things wrong with that: a GET is not where a
// decision about an order's lineage belongs, and a write nobody checks is a write
// that can quietly not happen.
//
// Acceptance is where an order gains its identity, so it is where the Development
// record behind it is settled: inside that transaction, audited with everything
// else, and never again.

describe("the Development lineage", () => {
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const {
    MerchandisingAuditEvent,
  } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

  test("acceptance records it, with an audit row saying how it was resolved", async () => {
    const w = await world("LINK", {
      developmentFiles: 1,
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });

    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(String(file.developmentReference.developmentFileId)).toBe(String(w.devFiles[0]._id));
    expect(file.developmentReference.developmentNumber).toBe(w.devFiles[0].developmentNumber);

    /* Resolved by the EXACT key — journey plus product line, which the
       collection's unique index makes unambiguous — not by the style alone. */
    const audit = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, recordId: file._id,
      "details.change": /recorded the Development record/,
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit.details.resolvedBy).toBe("JOURNEY_PRODUCT_LINE");
    expect(audit.details.developmentNumber).toBe(w.devFiles[0].developmentNumber);
  });

  test("reading the file afterwards changes nothing", async () => {
    const w = await world("READ", {
      developmentFiles: 1,
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const before = await ExecutionFile.findById(w.fileId).lean();
    const c = await cast(w.co);

    /* Three reads of the whole file, which is what a screen does on every visit. */
    for (let i = 0; i < 3; i += 1) {
      expect((await call(`/files/${w.fileId}`, at(w, c.viewer))).status).toBe(200);
    }
    const after = await ExecutionFile.findById(w.fileId).lean();
    expect(String(after.updatedAt)).toBe(String(before.updatedAt));
    expect(after.revision).toBe(before.revision);
  });

  test("an order with NO Development record is accepted, and the reason is recorded", async () => {
    /* Most orders never went through development. An ordinary state, not a failure
       — but the file should be able to say why it has no lineage rather than
       looking as though nobody checked. */
    const w = await world("NODEV", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.developmentReference?.developmentFileId ?? null).toBeNull();

    const audit = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, recordId: file._id,
      "details.change": /no Development record could be linked/,
    }).lean();
    expect(audit.details.reason).toBe("NO_DEVELOPMENT_RECORD");
  });

  test("a second file on another product line does not make this order's lineage a guess", async () => {
    /* Two files for one style is legitimate. The exact key still resolves, which is
       the whole point of having one — and it resolves to THIS line's file, not to
       whichever was touched last. */
    const w = await world("AMBIG", {
      developmentFiles: 2,
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(String(file.developmentReference.developmentFileId)).toBe(String(w.devFiles[0]._id));
    expect(String(file.developmentReference.developmentFileId)).not.toBe(String(w.devFiles[1]._id));
  });

  test("acceptance is all-or-nothing: a failed lineage step takes the acceptance with it", async () => {
    /* No swallowed failure. The link is recorded inside the acceptance
       transaction, so a file either carries its lineage or was never accepted. */
    const w = await world("TXN", {
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    const c = await cast(w.co);

    const { version: v2, correlationId } = await producer.issue({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineRef,
      body: {
        expectedCurrentVersionNo: 1,
        deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-11-20", quantity: 400 }],
        processRequirements: {
          processes: [
            {
              process: "EMBROIDERY", requirement: "REQUIRED", evidenceRef: w.evidenceRef,
              buyerSpecification: "As the buyer specified.",
              authorisationReason: "Company uniform order; processes decided in-house.",
            },
            { process: "PRINTING", requirement: "UNKNOWN" },
            { process: "WASHING", requirement: "UNKNOWN" },
          ],
        },
      },
      actor: { name: "Sales Person" },
    });
    await delivery.deliverPending({ companyId: w.co._id, correlationId });

    const before = await ExecutionFile.findById(w.fileId).lean();
    const adoption = require("../../services/merchandising/developmentAdoption.service");
    const spy = jest.spyOn(adoption, "developmentFileFor")
      .mockRejectedValueOnce(new Error("lineage store unavailable"));

    await expect(execution.acceptHandover({ companyId: w.co._id }, {
      id: String(v2._id), actor: { name: c.approver.name, email: c.approver.email },
    })).rejects.toThrow(/lineage store unavailable/);
    spy.mockRestore();

    /* The whole acceptance rolled back — the file still points at version 1. */
    const after = await ExecutionFile.findById(w.fileId).lean();
    expect(String(after.currentHandoverVersionId)).toBe(String(before.currentHandoverVersionId));
    expect(after.revision).toBe(before.revision);
  });

  test("a legacy file with no link stays readable, and has a deliberate repair route", async () => {
    const w = await world("LEGACY", {
      developmentFiles: 1,
      processes: [{ process: "EMBROIDERY", requirement: "REQUIRED" }],
    });
    /* Stripped, as a file accepted before the link was stamped would be. */
    await ExecutionFile.updateOne({ _id: w.fileId }, { $unset: { developmentReference: "" } });
    const c = await cast(w.co);

    /* Still readable — every reader resolves what it needs for its own answer. */
    expect((await call(`/files/${w.fileId}`, at(w, c.viewer))).status).toBe(200);
    expect(await ExecutionFile.findById(w.fileId).lean()
      .then((f) => f.developmentReference?.developmentFileId ?? null)).toBeNull();

    /* And the repair is a POST somebody asks for. */
    const repair = await call(`/files/${w.fileId}/development-link/repair`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(repair.status).toBe(200);
    expect(repair.body.repaired).toBe(true);
    expect(String((await ExecutionFile.findById(w.fileId).lean())
      .developmentReference.developmentFileId)).toBe(String(w.devFiles[0]._id));

    /* Idempotent — and it says which, rather than rewriting. */
    const again = await call(`/files/${w.fileId}/development-link/repair`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: {},
    });
    expect(again.body.repaired).toBe(false);
    expect(again.body.reason).toBe("ALREADY_LINKED");
  });
});
