// test/merchandising/preorder-development.route.test.js
//
// PRE-ORDER DEVELOPMENT — MERCHANDISING BEFORE THERE IS AN ORDER.
//
// Six claims, and they are the correction:
//
//   1  A JOURNEY PRODUCT LINE HAS A PERMANENT NAME. Not a position, not a
//      product name, not a mutable index — and it survives Sales rebuilding
//      the enquiry underneath it.
//
//   2  SALES ASKS; MERCHANDISING SELECTS. Merchandising cannot create a
//      request, Sales cannot touch a Development File, and no commercial
//      secret crosses.
//
//   3  THE BOM HOLDS IDENTITY ONLY. Consumption, allowance, rate, supplier
//      and stock are each refused BY NAME, saying whose fact they are.
//
//   4  APPROVAL IS MAKER/CHECKER AND FREEZES. Nobody approves their own
//      selection, owners included, and an approved revision is immutable.
//
//   5  R&D READS THE DEVELOPMENT SELECTION FIRST. The shortlist precedence
//      puts Merchandising's approved selection above the product BOM.
//
//   6  THE ORDER ADOPTS, AND NOTHING IS AUTO-APPROVED.
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
const {
  SalesDevelopmentRequest, REQUEST_STATE, FORBIDDEN_FIELDS,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile, DevelopmentRequestReceipt, DevelopmentBomRevision,
  LIFECYCLE, BOM_STATE, RECEIPT_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const {
  ensureProductLineIdentities, reconcileProductLineIdentities, PRODUCT_LINE_REF_PATTERN,
} = require("../../models/CMS_Models/Sales/enquiryProductLineIdentity");

let server, base, salesBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "preorder_dev" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/developmentRoute"));
  app.use("/api/cms/sales/development-requests", require("../../routes/CMS_Routes/Sales/developmentRequests"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales/development-requests`;
  await SalesDevelopmentRequest.syncIndexes();
  await DevelopmentFile.syncIndexes();
  await DevelopmentBomRevision.syncIndexes();
  await DevelopmentRequestReceipt.syncIndexes();
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

const call = (p, o) => req(base)(p, o);
const sales = (p, o) => req(salesBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `dev-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "D", lastName: `Ev${n}`, email, biometricId: `DV${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "D" });
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

/** A Journey with a product line that has a permanent reference. */
async function world({ withStyle = true } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Dev ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-D-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-D-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `Polo ${n}`, quantity: 500 }, { product: `Tee ${n}`, quantity: 200 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  const productLineRef = String(saved.products[0].productLineRef);

  let style = null;
  if (withStyle) {
    style = await SampleStyle.create({
      sampleStyleId: `SS-D-${n}`, styleCode: `SC-D-${n}`, productName: `Polo ${n}`,
      journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
      materials: { status: "pending", rawItems: [] },
    });
  }
  return { co, journey, enquiry, productLineRef, style, seq: n };
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

/** Sales asks Merchandising to select materials. */
async function askForDevelopment(w, who, over = {}) {
  return sales(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
    ...at(w, who), method: "POST",
    body: {
      requirementSummary: "Navy pique polo with a woven neck label and the buyer's own button.",
      requestedCategories: ["FABRIC", "TRIMS", "LABELS"],
      requiredByDate: "2026-10-15",
      ...(w.style ? { sampleStyleId: String(w.style._id) } : {}),
      ...over,
    },
  });
}

/** The Development File the request opened. */
async function fileFor(w) {
  return DevelopmentFile.findOne({
    companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef,
  }).lean();
}

/* ══ 1 — PERMANENT PRODUCT LINE IDENTITY ══════════════════════════════════ */

describe("a Journey product line has a permanent name", () => {
  test("every product row is minted a reference on save", async () => {
    const w = await world();
    const enquiry = await Enquiry.findById(w.enquiry._id).lean();
    expect(enquiry.products).toHaveLength(2);
    for (const p of enquiry.products) {
      expect(p.productLineRef).toMatch(PRODUCT_LINE_REF_PATTERN);
    }
    /* Two lines never share one. */
    expect(enquiry.products[0].productLineRef).not.toBe(enquiry.products[1].productLineRef);
  });

  test("it is not the position, the name or the mongoose id", async () => {
    const w = await world();
    const before = await Enquiry.findById(w.enquiry._id);
    const held = before.products.map((p) => p.productLineRef);

    /* Reorder and rename — the identity must not move with either. */
    before.products.reverse();
    before.products[0].product = "Renamed entirely";
    await before.save();

    const after = await Enquiry.findById(w.enquiry._id).lean();
    expect(after.products.map((p) => p.productLineRef)).toEqual([held[1], held[0]]);
  });

  /* These two used to assert a PRODUCT-NAME fallback: an unnamed "Polo" row
     inherited the first unclaimed "Polo" line's reference, and a forged
     reference was silently swapped for that name match. One enquiry carries
     "Polo" twice as two development jobs, so a name match hands one line's
     Development File to the other. Identity is now the reference alone (G01);
     see test/crm/enquiry-product-identity.route.test.js for the route. */
  test("a rebuilt row carries its identity only when the payload names it", () => {
    const existing = [
      { productLineRef: "PL-aaaaaaaaaaaa", product: "Polo" },
      { productLineRef: "PL-bbbbbbbbbbbb", product: "Tee" },
    ];
    /* Reordered and renamed — both rows still name their own line. */
    const rebuilt = [
      { productLineRef: "PL-bbbbbbbbbbbb", product: "Tee" },
      { productLineRef: "PL-aaaaaaaaaaaa", product: "Polo (navy)" },
    ];
    const verdict = reconcileProductLineIdentities(existing, rebuilt);
    expect(verdict.ok).toBe(true);
    expect(rebuilt.map((r) => r.productLineRef)).toEqual(["PL-bbbbbbbbbbbb", "PL-aaaaaaaaaaaa"]);

    /* An unnamed row beside a missing held line is NOT matched by name. */
    const stale = reconcileProductLineIdentities(existing, [
      { productLineRef: "PL-bbbbbbbbbbbb", product: "Tee" }, { product: "Polo" },
    ]);
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("PRODUCT_LINES_STALE");
  });

  test("a client cannot invent one the enquiry does not hold", () => {
    const existing = [{ productLineRef: "PL-aaaaaaaaaaaa", product: "Polo" }];
    const verdict = reconcileProductLineIdentities(existing, [{ productLineRef: "PL-ffffffffffff", product: "Polo" }]);
    /* Refused — not quietly replaced with a same-named line. */
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("PRODUCT_LINE_REF_UNKNOWN");
  });

  test("a duplicate reference is refused, never quietly repaired", () => {
    expect(() => ensureProductLineIdentities([
      { productLineRef: "PL-aaaaaaaaaaaa" }, { productLineRef: "PL-aaaaaaaaaaaa" },
    ])).toThrow(/carry the reference/i);
  });

  test("a reference this system did not issue is refused", () => {
    expect(() => ensureProductLineIdentities([{ productLineRef: "LINE-3" }]))
      .toThrow(/not a product line reference this system issued/i);
  });
});

/* ══ 2 — SALES ASKS, MERCHANDISING SELECTS ════════════════════════════════ */

describe("Sales asks; Merchandising cannot ask itself", () => {
  test("no Merchandising route creates a development request", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/developmentRoute.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/SalesDevelopmentRequest/);
    /* Every POST under `/development` acts on a file that already exists —
       none of them opens one. (The order-adoption routes sit on `/files/:id`,
       because the record being adopted INTO is an execution file.) */
    const posts = [...bare.matchAll(/router\.post\("([^"]+)"/g)].map((m) => m[1]);
    const developmentPosts = posts.filter((x) => x.startsWith("/development"));
    expect(developmentPosts.length).toBeGreaterThan(0);
    for (const p of developmentPosts) expect(p).toMatch(/:fileId/);
  });

  test("no Merchandising service writes the request model", () => {
    const dir = path.join(__dirname, "../../services/merchandising");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const bare = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(bare).not.toMatch(/SalesDevelopmentRequest\.create/, f);
    }
  });

  test("a Merchandising grant is refused on the Sales route", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const who of [c.owner, c.approver, c.admin]) {
      expect((await askForDevelopment(w, who)).status).toBe(403);
    }
  });

  test("a Sales approver asks, and a Sales viewer cannot", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await askForDevelopment(w, c.salesViewer)).status).toBe(403);
    const ok = await askForDevelopment(w, c.salesApprover);
    expect(ok.status).toBe(201);
    expect(ok.body.request.requestRef).toMatch(/^DRQ-/);
    expect(ok.body.request.versionNo).toBe(1);
    /* And it is rooted on the permanent line reference. */
    expect(ok.body.request.productLineRef).toBe(w.productLineRef);
  });

  test("a buyer target-price ceiling crosses only as a read-only selection constraint", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await askForDevelopment(w, c.salesApprover, {
      targetPriceCeiling: { amount: 850, currency: "inr", basis: "PER_PIECE" },
    });
    expect(asked.status).toBe(201);
    expect(asked.body.request.targetPriceCeiling).toEqual({
      amount: 850, currency: "INR", basis: "PER_PIECE",
    });

    const file = await fileFor(w);
    const read = await call(`/development/${file._id}`, at(w, c.viewer));
    expect(read.status).toBe(200);
    expect(read.body.request.targetPriceCeiling).toEqual({
      amount: 850, currency: "INR", basis: "PER_PIECE",
    });
    expect(JSON.stringify(read.body.file)).not.toMatch(/targetPrice|priceCeiling/i);
  });

  test("no commercial secret crosses, and each refusal names its owner", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (const field of [
      "opportunityValue", "margin", "price", "negotiation", "quotation",
      "internalNote", "message", "contact", "stage", "probability",
    ]) {
      const res = await askForDevelopment(w, c.salesApprover, { [field]: "x" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBe("DEVELOPMENT_FIELD_NOT_ALLOWED");
      expect(res.body.error.details.field).toBe(field);
      expect(res.body.message).toMatch(/Sales|Merchandising/);
    }
  });

  test("the schema has no field that could hold one", () => {
    /* ── AN ACTOR'S OWN ADDRESS IS NOT A CUSTOMER CONTACT ──────────────
       `email` is forbidden because a BUYER's contact details do not belong on
       a development request. The acting colleague's own address, recorded
       against the act they performed, is a different fact — which is why
       `requestedBy` was exempted here from the start. `release.authorisedBy`
       is the same shape for the same reason: who authorised the release.
       Matched on the actor reference rather than on the two names it happens
       to have today. */
    const paths = Object.keys(SalesDevelopmentRequest.schema.paths)
      .filter((p) => !/(^|\.)(requestedBy|authorisedBy)\./.test(p));
    for (const banned of Object.keys(FORBIDDEN_FIELDS)) {
      expect(paths.some((p) => p.split(".").includes(banned))).toBe(false);
    }
  });

  test("asking opens a Development File, and nothing more", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await askForDevelopment(w, c.salesApprover);
    expect(asked.body.downstream.delivered).toBe(true);

    const file = await fileFor(w);
    expect(file).toBeTruthy();
    expect(file.developmentNumber).toMatch(/^MDV-\d{4}-\d{4}$/);
    /* NEW: arriving decides nothing. */
    expect(file.lifecycleStatus).toBe(LIFECYCLE.NEW);
    expect(file.currentBomRevisionNo).toBeNull();
    expect(await DevelopmentBomRevision.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await DevelopmentRequestReceipt.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a reissue is version 2 on the SAME file, keeping the selection", async () => {
    const w = await world();
    const c = await cast(w.co);
    const one = await askForDevelopment(w, c.salesApprover);
    /* Accepting is `brief.review`, at approver: the same authority that
       accepts a Sales handover, because it is the same kind of act. */
    await call(`/development/${(await fileFor(w))._id}/accept`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
    });

    const two = await askForDevelopment(w, c.salesApprover, {
      requirementSummary: "The buyer changed the neck label to a printed one instead of woven.",
    });
    expect(two.status).toBe(201);
    expect(two.body.request.requestRef).toBe(one.body.request.requestRef);
    expect(two.body.request.versionNo).toBe(2);

    /* One file, not two. */
    expect(await DevelopmentFile.countDocuments({
      companyId: w.co._id, journeyId: w.journey._id,
    })).toBe(1);
    const file = await fileFor(w);
    expect(file.currentRequestVersionNo).toBe(2);
    expect(file.requestHistory).toHaveLength(2);

    /* The receipt on version 1 is superseded, so the file asks to be answered
       again — and the earlier decision is kept. */
    const receipts = await DevelopmentRequestReceipt.find({ companyId: w.co._id }).lean();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].state).toBe(RECEIPT_STATE.SUPERSEDED);
    expect(receipts[0].decidedAt).toBeTruthy();
  });

  test("redelivery is idempotent", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const event = await SalesHandoverOutboxEvent.findOne({
      companyId: w.co._id, kind: "sales.development_request.issued",
    }).lean();
    const intake = require("../../services/merchandising/developmentIntake.service");
    const again = await intake.receive(event);
    expect(again.duplicate).toBe(true);
    expect(await DevelopmentFile.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("Sales has no route that reads or writes a Development File", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/developmentRequests.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/DevelopmentFile|DevelopmentBomRevision/);
  });
});

/* ══ 3 — THE BOM HOLDS IDENTITY ONLY ══════════════════════════════════════ */

describe("the development BOM records identity, never somebody else's fact", () => {
  async function draftOn(w, c) {
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const made = await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    return { file, revisionNo: made.body.revisionNo };
  }

  test("consumption, rate, supplier and stock are each refused BY NAME", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const { file } = await draftOn(w, c);

    for (const [field, owner] of [
      ["quantity", /R&D/], ["consumption", /R&D/], ["allowancePercent", /R&D/],
      ["rate", /Costing/], ["unitCost", /Costing/],
      ["supplier", /Supply Chain/], ["purchaseOrder", /Store/], ["stock", /Store/],
    ]) {
      const res = await call(`/development/${file._id}/bom/rows`, {
        ...at(w, c.editor), method: "POST",
        body: { category: "FABRIC", rawItemName: "Pique 180gsm", [field]: 1, expectedRevision: 0 },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBe("DEVELOPMENT_FIELD_NOT_ALLOWED");
      expect(res.body.message).toMatch(owner);
    }
  });

  test("the model has no field for any of them", () => {
    const paths = Object.keys(DevelopmentBomRevision.schema.path("rows").schema.paths);
    for (const banned of [
      "quantity", "consumption", "unit", "allowance", "allowancePercent", "wastage",
      "rate", "unitCost", "totalCost", "price", "supplier", "supplierId",
      "purchaseOrder", "stock", "reserved", "issueQuantity", "sampleResult",
    ]) {
      expect(paths).not.toContain(banned);
    }
  });

  test("a row gets a permanent reference that survives cloning", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const { file } = await draftOn(w, c);

    const added = await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        category: "FABRIC", rawItemName: "Pique 180gsm", colourOrShade: "Navy",
        expectedRevision: 0,
      },
    });
    expect(added.status).toBe(201);
    const rowRef = added.body.rowRef;
    expect(rowRef).toMatch(/^DR-[0-9a-f]{10}$/);

    /* Submit, approve, then clone into revision 2 — the row keeps its name. */
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: draft.revision },
    });
    const submitted = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: submitted.revision },
    });

    const cloned = await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { fromRevisionNo: 1 },
    });
    expect(cloned.status).toBe(201);
    const rev2 = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, revisionNo: 2,
    }).lean();
    expect(rev2.rows[0].rowRef).toBe(rowRef);
    expect(rev2.clonedFromRevisionNo).toBe(1);
  });

  test("two drafts cannot coexist", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const { file } = await draftOn(w, c);
    const second = await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(second.body.error.code).toBe("DEVELOPMENT_BOM_EXISTS");
  });

  test("an empty selection cannot be submitted", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const { file } = await draftOn(w, c);
    const res = await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: 0 },
    });
    expect(res.body.error.code).toBe("DEVELOPMENT_BOM_EMPTY");
    expect(res.body.message).toMatch(/tells R&D nothing/i);
  });
});

/* ══ 4 — MAKER/CHECKER AND IMMUTABILITY ═══════════════════════════════════ */

describe("approval is maker/checker, and freezes", () => {
  async function submitted(w, c, author = null) {
    const who = author || c.editor;
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, who), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, who), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", expectedRevision: 0 },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, who), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    return file;
  }

  test("the submitter cannot approve their own selection", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await submitted(w, c, c.approver);
    const rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    const res = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    expect(res.body.error.code).toBe("DEVELOPMENT_SELF_APPROVAL");
  });

  test("an OWNER is not an exception either", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await submitted(w, c, c.owner);
    const rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    const res = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.owner), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    expect(res.body.error.code).toBe("DEVELOPMENT_SELF_APPROVAL");
  });

  test("somebody else approves it, and the file becomes APPROVED", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await submitted(w, c, c.editor);
    const rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    const res = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(BOM_STATE.APPROVED);
    /* And it says what happens next, and whose call it is. */
    expect(res.body.note).toMatch(/Sales authorises release/i);

    const after = await fileFor(w);
    expect(after.lifecycleStatus).toBe(LIFECYCLE.APPROVED);
    expect(after.currentBomRevisionNo).toBe(1);

    /* Published, so R&D and Costing can read it. */
    const event = await MerchandisingOutboxEvent.findOne({
      companyId: w.co._id, kind: OUTBOX_KIND.DEVELOPMENT_BOM_APPROVED,
    }).lean();
    expect(event.payload.bomRevisionNo).toBe(1);
  });

  test("an approved revision is frozen", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await submitted(w, c, c.editor);
    const rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });

    const approved = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.APPROVED,
    });
    approved.rows[0].rawItemName = "Something else";
    await expect(approved.save()).rejects.toThrow(/frozen/i);
  });

  test("revision 2 supersedes revision 1, and revision 1 stays readable", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await submitted(w, c, c.editor);
    let rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    const firstRows = (await DevelopmentBomRevision.findOne({
      companyId: w.co._id, revisionNo: 1,
    }).lean()).rows.map((r) => r.rawItemName);

    await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { fromRevisionNo: 1 },
    });
    let draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "TRIM", rawItemName: "Horn button", expectedRevision: draft.revision },
    });
    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    const second = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    expect(second.body.supersededRevisionNo).toBe(1);

    const one = await DevelopmentBomRevision.findOne({ companyId: w.co._id, revisionNo: 1 }).lean();
    expect(one.state).toBe(BOM_STATE.SUPERSEDED);
    /* Superseded, not deleted, and unchanged. */
    expect(one.rows.map((r) => r.rawItemName)).toEqual(firstRows);
    expect(one.approvedAt).toBeTruthy();
    /* One approved revision, enforced by the partial unique index. */
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, state: BOM_STATE.APPROVED,
    })).toBe(1);
  });

  test("Merchandising has no route that releases to R&D", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Merchandising/developmentRoute.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(bare).not.toMatch(/release/i);
  });

  test("Sales authorises release, and only after approval", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await askForDevelopment(w, c.salesApprover);
    const ref = asked.body.request.requestRef;

    /* ── TOO EARLY IS REFUSED BY NAME, NOT ACCEPTED AND DROPPED ───────
       This used to answer 200 and then quietly do nothing downstream, which
       told the person their release had gone through. Both shapes of "too
       early" are now answered where the click happens. */
    const unnamed = await sales(`/${ref}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: {},
    });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_REQUIRED");

    const early = await sales(`/${ref}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("DEVELOPMENT_NOT_AWAITING_SALES");
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.NEW);

    const file = await submitted(w, c, c.editor);
    const rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });

    const released = await sales(`/${ref}/authorise-release`, {
      ...at(w, c.salesApprover),
      method: "POST",
      body: { note: "Buyer confirmed the sample spend.", expectedBomRevisionNo: 1 },
    });
    expect(released.status).toBe(200);
    const after = await fileFor(w);
    expect(after.lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect(after.releaseReference).toMatch(/^REL-/);
  });
});

/* ══ 5 — R&D READS THE DEVELOPMENT SELECTION FIRST ════════════════════════ */

describe("the shortlist precedence puts Merchandising's selection first", () => {
  test("an approved development BOM outranks the registered product's", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Development pique", expectedRevision: 0 },
    });
    let rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });
    rev = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: rev.revision },
    });

    const { approvedShortlistFor } = require("../../services/approvedMaterialShortlist.service");
    const style = await SampleStyle.findById(w.style._id).lean();
    const shortlist = await approvedShortlistFor(style);

    expect(shortlist.source).toBe("DEVELOPMENT_BOM");
    expect(shortlist.developmentBomRevisionNo).toBe(1);
    expect(shortlist.rows.map((r) => r.rawItemName)).toContain("Development pique");
    expect(shortlist.blocker).toBeNull();
    /* And it carries no consumption — identity only, by construction. */
    for (const row of shortlist.rows) {
      expect(row.quantity).toBeUndefined();
      expect(row.unitCost).toBeUndefined();
      expect(row.allowancePercent).toBeUndefined();
    }
  });

  test("with no development selection, the blocker still names Merchandising", async () => {
    const w = await world();
    const { approvedShortlistFor } = require("../../services/approvedMaterialShortlist.service");
    const style = await SampleStyle.findById(w.style._id).lean();
    const shortlist = await approvedShortlistFor(style);
    expect(shortlist.source).toBe("NONE");
    expect(shortlist.blocker.owner).toBe("MERCHANDISING");
    /* It names WHERE to go, which the old message could not. */
    expect(shortlist.blocker.message).toMatch(/Development file/i);
  });
});

/* ══ 6 — THE ORDER ADOPTS, AND NOTHING IS AUTO-APPROVED ═══════════════════ */

describe("a confirmed order adopts the development selection", () => {
  test("the adoption service never approves an order-stage revision", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/developmentAdoption.service.js"), "utf8",
    );
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    /* It calls M3's draft and row commands, and nothing that approves. */
    expect(bare).toMatch(/selection\.createDraft/);
    expect(bare).toMatch(/selection\.addRow/);
    expect(bare).not.toMatch(/selection\.approve/);
    /* And it never writes a development revision back. */
    expect(bare).not.toMatch(/DevelopmentBomRevision\.create|DevelopmentBomRevision\.updateOne/);
  });

  test("the handover and the execution file carry an exact reference", () => {
    const V = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
    const F = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    for (const M of [V, F]) {
      expect(M.schema.path("developmentReference.developmentFileId")).toBeTruthy();
      expect(M.schema.path("developmentReference.bomRevisionNo")).toBeTruthy();
      expect(M.schema.path("developmentReference.releaseReference")).toBeTruthy();
    }
  });
});

/* ══ COMPANY ISOLATION AND CAPABILITIES ═══════════════════════════════════ */

describe("nothing crosses a company boundary", () => {
  test("company B cannot read or act on company A's development file", async () => {
    const a = await world();
    const b = await world();
    const ca = await cast(a.co);
    await askForDevelopment(a, ca.salesApprover);
    const file = await fileFor(a);

    const intruder = await actor({
      companies: [b.co], grants: { merchandiser: "owner", sales: "approver" },
    });
    for (const [p, method, body] of [
      [`/development/${file._id}`, "GET", undefined],
      [`/development/${file._id}/accept`, "POST", {}],
      [`/development/${file._id}/bom`, "POST", {}],
    ]) {
      const res = await call(p, { token: intruder.token, company: b.co._id, method, body, key: uniq() });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }

    const register = await call("/development?view=all", { token: intruder.token, company: b.co._id });
    expect(register.body.rows.every((r) => r.id !== String(file._id))).toBe(true);
  });
});

describe("the capability matrix", () => {
  test("a viewer reads but cannot select; an editor can", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    expect((await call(`/development/${file._id}`, at(w, c.viewer))).status).toBe(200);

    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    const denied = await call(`/development/${file._id}/bom`, {
      ...at(w, c.viewer), method: "POST", key: uniq(), body: {},
    });
    expect(denied.status).toBe(403);
    const allowed = await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: {},
    });
    expect(allowed.status).toBe(201);
  });

  test("a platform admin reaches nothing", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    expect((await call("/development", at(w, c.admin))).status).toBe(403);
  });

  test("a revoked grant stops working on the very next request", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await call("/development", at(w, c.viewer))).status).toBe(200);
    await DepartmentRole.updateMany({ email: c.viewer.email }, { $set: { isActive: false } });
    expect((await call("/development", at(w, c.viewer))).status).toBe(403);
  });

  test("no capability constant was added for pre-order work", () => {
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

    /* And nothing named for pre-order work exists: development is authorised
       by the same capabilities as everything else, because choosing a material
       before an order and choosing one after it are the same kind of decision
       at two different stages. */
    for (const name of Object.keys(access.CAPABILITY)) {
      expect(name).not.toMatch(/DEVELOPMENT|PREORDER|PRE_ORDER|BOM/i);
    }
    for (const value of Object.values(access.CAPABILITY)) {
      expect(value).not.toMatch(/development|pre_?order/i);
    }
  });
});

/* ══ THE REGISTER ═════════════════════════════════════════════════════════ */

describe("the Development register", () => {
  test("its views are the six the workflow has, and it pages by cursor", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const res = await call("/development?view=new", at(w, c.viewer));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.views).toEqual(
      expect.arrayContaining(["new", "active", "awaiting-approval", "approved", "released-to-rnd", "closed"]),
    );
    const capped = await call("/development?view=all&limit=9999", at(w, c.viewer));
    expect(capped.body.rows.length).toBeLessThanOrEqual(100);
  });

  test("the clarification count opens the records it counted", async () => {
    /* Asking Sales a question does NOT move the file's lifecycle, so the `new`
       view alone is a superset of what the count counted. The filter is on the
       receipt, and it is applied before paging. */
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);

    const before = await call("/development?view=new&awaitingClarification=true", at(w, c.viewer));
    expect(before.status).toBe(200);
    expect(before.body.rows).toHaveLength(0);

    const file = await fileFor(w);
    await call(`/development/${file._id}/clarify`, {
      ...at(w, c.approver),
      method: "POST",
      body: {
        category: "REFERENCE_MISSING",
        reason: "No reference picture for the neck label.",
        idempotencyKey: uniq(),
      },
    });

    const counts = await call("/development/overview", at(w, c.viewer));
    expect(counts.body.counts.developmentClarifications).toBe(1);

    const after = await call("/development?view=new&awaitingClarification=true", at(w, c.viewer));
    expect(after.body.rows).toHaveLength(counts.body.counts.developmentClarifications);
    expect(after.body.rows[0].awaitingClarification).toBe(true);

    /* And the file is still in `new` — the question changed nothing else. */
    const plain = await call("/development?view=new", at(w, c.viewer));
    expect(plain.body.rows).toHaveLength(1);
  });

  test("the Overview counts open their exact records", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const counts = await call("/development/overview", at(w, c.viewer));
    expect(counts.status).toBe(200);
    expect(counts.body.counts.newDevelopmentRequests).toBe(1);

    const list = await call("/development?view=new", at(w, c.viewer));
    expect(list.body.rows).toHaveLength(counts.body.counts.newDevelopmentRequests);
  });
});

/* ══ 7 — WHAT SALES SEES BACK ═════════════════════════════════════════════
   The correction's last mile. Sales asked; Sales has to be able to see the
   answer, the approved selection and whether it is now their move — and has to
   be able to see all of that WITHOUT holding a handle on anything of
   Merchandising's. */

describe("Merchandising publishes its answer; Sales reads it and holds nothing", () => {
  test("the Journey's product lines come back by permanent reference", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await sales(`/journeys/${w.journey._id}/lines`, at(w, c.salesViewer));
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    for (const line of res.body.lines) {
      expect(line.productLineRef).toMatch(PRODUCT_LINE_REF_PATTERN);
      expect(line.productName).toBeTruthy();
    }
    /* And the reference is the enquiry's own, not a position. */
    expect(res.body.lines[0].productLineRef).toBe(w.productLineRef);
  });

  test("before anybody asks, a line has no development answer at all", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
    /* Not a zero, not an empty projection with a green state: nothing. */
    expect(res.body.merchandising).toEqual({});
  });

  test("the answer names whose move it is at every step", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);

    const pending = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    const line = pending.body.merchandising[w.productLineRef];
    expect(line.receiptState).toBe("PENDING");
    expect(line.position).toMatch(/Merchandising has not answered/i);
    /* Nothing is approved, so nothing is published as chosen. */
    expect(line.approvedRevisionNo).toBeNull();
    expect(line.selectedMaterials).toEqual([]);
    expect(line.releaseAwaitingSales).toBe(false);

    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, {
      ...at(w, c.approver), method: "POST", body: { idempotencyKey: uniq() },
    });
    const accepted = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    expect(accepted.body.merchandising[w.productLineRef].receiptState).toBe("ACCEPTED");
    expect(accepted.body.merchandising[w.productLineRef].position).toMatch(/has not started a selection/i);
  });

  test("a question to Sales reaches Sales, in full", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/clarify`, {
      ...at(w, c.approver),
      method: "POST",
      body: {
        category: "REFERENCE_MISSING",
        reason: "No reference picture for the neck label.",
        idempotencyKey: uniq(),
      },
    });
    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    const line = res.body.merchandising[w.productLineRef];
    expect(line.receiptState).toBe("CLARIFICATION_REQUESTED");
    expect(line.clarification.reason).toMatch(/neck label/);
    expect(line.position).toMatch(/waiting on Sales/i);
  });

  test("a DRAFT selection is never published to Sales", async () => {
    /* A draft is Merchandising still working. Publishing one would let a
       salesperson quote a fabric nobody has agreed to. */
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, {
      ...at(w, c.approver), method: "POST", body: { idempotencyKey: uniq() },
    });
    await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor),
      method: "POST",
      body: {
        category: "FABRIC", rawItemName: "Navy pique", colourOrShade: "Navy",
        expectedRevision: draft.revision ?? 0,
      },
    });

    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    const line = res.body.merchandising[w.productLineRef];
    expect(line.workingState).toBe("DRAFT");
    expect(line.approvedRevisionNo).toBeNull();
    expect(line.selectedMaterials).toEqual([]);
  });

  test("an APPROVED selection is published as identity, and only identity", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, {
      ...at(w, c.approver), method: "POST", body: { idempotencyKey: uniq() },
    });
    await call(`/development/${file._id}/bom`, {
      ...at(w, c.editor), method: "POST", body: { idempotencyKey: uniq() },
    });
    let bom = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor),
      method: "POST",
      body: {
        category: "FABRIC", rawItemName: "Navy pique", rawItemSku: "PQ-220",
        colourOrShade: "Navy", finish: "Enzyme wash", placement: "Body",
        expectedRevision: bom.revision ?? 0,
      },
    });
    bom = await DevelopmentBomRevision.findById(bom._id).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor),
      method: "POST",
      body: { expectedRevision: bom.revision ?? 0, idempotencyKey: uniq() },
    });
    bom = await DevelopmentBomRevision.findById(bom._id).lean();
    const approved = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver),
      method: "POST",
      body: { expectedRevision: bom.revision ?? 0, idempotencyKey: uniq() },
    });
    expect(approved.status).toBe(200);

    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    const line = res.body.merchandising[w.productLineRef];
    expect(line.approvedRevisionNo).toBe(1);
    expect(line.selectedMaterials).toHaveLength(1);

    const row = line.selectedMaterials[0];
    expect(row.name).toBe("Navy pique");
    expect(row.colourOrShade).toBe("Navy");
    /* Identity only. Nothing R&D, Costing, Supply Chain or Store owns crosses,
       and neither does a handle a Sales screen could act on. */
    for (const forbidden of [
      "quantity", "consumption", "allowance", "wastage", "rate", "unitCost",
      "totalCost", "supplier", "purchaseOrder", "stock", "sampleResult",
      "rowRef", "id", "_id", "developmentFileId", "revisionId",
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }

    /* And now it is Sales' move — stated as a fact about the RECORD. */
    expect(line.releaseAwaitingSales).toBe(true);
    expect(line.position).toMatch(/waiting on Sales to authorise/i);
  });

  test("the projection hands out no identifier a caller could act on", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    const line = res.body.merchandising[w.productLineRef];
    /* The development NUMBER is for a person to quote. There is no document id
       here, because there is no Merchandising route that would take one from
       Sales and publishing one would only invite somebody to try. */
    expect(line.developmentNumber).toMatch(/^MDV-/);
    for (const forbidden of [
      "developmentFileId", "fileId", "id", "_id", "requestId", "revisionId", "bomId",
    ]) {
      expect(line).not.toHaveProperty(forbidden);
    }
  });

  test("the publication is scoped to the company like everything else", async () => {
    const pub = require("../../services/merchandising/developmentPublication.service");
    await expect(pub.forJourney({}, { journeyId: "x" })).rejects.toMatchObject({
      code: "COMPANY_CONTEXT_UNAVAILABLE",
    });
  });

  test("it is a read: the publication module contains no write at all", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/developmentPublication.service.js"), "utf8",
    );
    for (const banned of [
      /\.create\(/, /\.save\(/, /findOneAndUpdate/, /updateOne/, /updateMany/,
      /deleteOne/, /deleteMany/, /bulkWrite/, /startSession/,
    ]) {
      expect(src).not.toMatch(banned);
    }
  });

  test("a Sales viewer reads the answer; asking still needs the issue authority", async () => {
    const w = await world();
    const c = await cast(w.co);
    const read = await sales(`/journeys/${w.journey._id}`, at(w, c.salesViewer));
    expect(read.status).toBe(200);
    const asked = await askForDevelopment(w, c.salesViewer);
    expect(asked.status).toBe(403);
  });

  test("a Merchandising grant does not open the Sales projection", async () => {
    /* The projection is published TO the asker. Reaching it is still the Sales
       router's question, answered against the live Sales grant. */
    const w = await world();
    const c = await cast(w.co);
    const res = await sales(`/journeys/${w.journey._id}`, at(w, c.owner));
    expect(res.status).toBe(403);
  });
});

/* ══ 7 — A RELEASE BINDS ONE EXACT REVISION ═══════════════════════════════

   The defect this closes: Sales authorised a REQUEST, and R&D's intake then
   read whichever revision the development file happened to point at when the
   event was delivered. Sales reviewed revision 1 and R&D could receive
   revision 2, with nothing anywhere recording that the two were different.

   Everything below is about one identity — `{companyId, developmentFileId,
   revisionNo}` — being decided once, at the click, and then never re-derived. */

describe("Sales releases the revision it reviewed, and only that one", () => {
  /** Ask, accept, select, submit and approve. Leaves one APPROVED revision. */
  async function approvedLine(w, c) {
    const asked = await askForDevelopment(w, c.salesApprover);
    const requestRef = asked.body.request.requestRef;
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", expectedRevision: 0 },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    return { requestRef, fileId: file._id };
  }

  /** Raise, submit and approve the next revision on an already-approved file. */
  async function nextRevision(w, c, fileId, fromRevisionNo) {
    await call(`/development/${fileId}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { fromRevisionNo },
    });
    let draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "TRIM", rawItemName: "Horn button", expectedRevision: draft.revision },
    });
    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.SUBMITTED,
    }).lean();
    const res = await call(`/development/${fileId}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    expect(res.status).toBe(200);
  }

  const releaseEvents = (co) => {
    const { SalesHandoverOutboxEvent } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    return SalesHandoverOutboxEvent.find({
      companyId: co._id, kind: "sales.development_release.authorised",
    }).lean();
  };

  /* ── 1 ─────────────────────────────────────────────────────────────── */
  test("the exact revision on screen is what gets released and recorded", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);

    const res = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, note: "Buyer confirmed the spend." },
    });
    expect(res.status).toBe(200);
    expect(res.body.bomRevisionNo).toBe(1);
    expect(String(res.body.developmentFileId)).toBe(String(fileId));

    /* Stored on the request version, as the identity — not as a journey and a
       line, which would name a file whose approved revision moves. */
    const req = await SalesDevelopmentRequest.findOne({
      companyId: w.co._id, requestRef,
    }).lean();
    expect(req.release.bomRevisionNo).toBe(1);
    expect(String(req.release.developmentFileId)).toBe(String(fileId));
    expect(req.release.authorisedAt).toBeTruthy();
    expect(req.release.releaseReference).toMatch(/^REL-/);
  });

  /* ── 2 ─────────────────────────────────────────────────────────────── */
  test("a revision approved while the panel was open refuses the release", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);

    /* The panel is showing revision 1. Merchandising approves revision 2. */
    await nextRevision(w, c, fileId, 1);

    const res = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_CHANGED");
    expect(res.body.error.details.currentBomRevisionNo).toBe(2);

    /* NOTHING happened: no release stamped, no event, file still awaiting. */
    const req = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(req.release?.authorisedAt == null).toBe(true);
    expect(await releaseEvents(w.co)).toHaveLength(0);
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.APPROVED);

    /* And releasing the revision that IS approved still works. */
    const ok = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 2 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.bomRevisionNo).toBe(2);
  });

  /* ── 3 ─────────────────────────────────────────────────────────────── */
  test("an approved file with no approved revision is a named readiness refusal", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);

    /* A record that says APPROVED while holding no approved revision. The
       person clicking needs to be told what is missing, not handed a 500. */
    await DevelopmentFile.updateOne(
      { _id: file._id }, { $set: { lifecycleStatus: LIFECYCLE.APPROVED, currentBomRevisionNo: null } },
    );

    const res = await sales(`/${asked.body.request.requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVELOPMENT_NOT_APPROVED");
    expect(res.body.message).toMatch(/approve the selection/i);
    expect(await releaseEvents(w.co)).toHaveLength(0);
  });

  /* ── 4 ─────────────────────────────────────────────────────────────── */
  test("a file that is not awaiting Sales is refused by name", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });

    const res = await sales(`/${asked.body.request.requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVELOPMENT_NOT_AWAITING_SALES");
    expect(await releaseEvents(w.co)).toHaveLength(0);
  });

  /* ── 5 ─────────────────────────────────────────────────────────────── */
  test("identity comes from the server, so a foreign caller or number is unreachable", async () => {
    const a = await world();
    const ca = await cast(a.co);
    const { requestRef } = await approvedLine(a, ca);

    /* Company B's actor cannot release company A's request. The request is
       looked up inside the ACTING company, so for them it does not exist —
       they are not refused company A's release, they are told there is no
       such request, which is the only thing they are entitled to know. */
    const b = await world();
    const cb = await cast(b.co);
    const foreign = await sales(`/${requestRef}/authorise-release`, {
      ...at(b, cb.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("DEVELOPMENT_REQUEST_NOT_FOUND");
    expect(await releaseEvents(b.co)).toHaveLength(0);
    expect(await releaseEvents(a.co)).toHaveLength(0);

    /* A Sales viewer in the owning company is refused on authority, before
       any of this is reached. */
    const viewer = await sales(`/${requestRef}/authorise-release`, {
      ...at(a, ca.salesViewer), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(viewer.status).toBe(403);

    /* And nothing is ever LOOKED UP by the number the caller sends — it is
       only ever compared against this line's own approved revision — so a
       number that means something on a different file still refuses here. */
    const wrongNumber = await sales(`/${requestRef}/authorise-release`, {
      ...at(a, ca.salesApprover), method: "POST", body: { expectedBomRevisionNo: 99 },
    });
    expect(wrongNumber.status).toBe(409);
    expect(wrongNumber.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_CHANGED");
    expect(wrongNumber.body.error.details.currentBomRevisionNo).toBe(1);
    expect(await releaseEvents(a.co)).toHaveLength(0);
  });

  /* ── 6 ─────────────────────────────────────────────────────────────── */
  test("the outbox event carries the bound file and revision", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });

    const [event] = await releaseEvents(w.co);
    expect(String(event.payload.developmentFileId)).toBe(String(fileId));
    expect(event.payload.bomRevisionNo).toBe(1);
    /* The line identity is preserved beside it, not replaced by it. */
    expect(event.payload.requestRef).toBe(requestRef);
    expect(event.payload.requestVersionNo).toBe(1);
    expect(String(event.payload.journeyId)).toBe(String(w.journey._id));
    expect(event.payload.productLineRef).toBe(w.productLineRef);
  });

  test("an unbound release event cannot even be written", async () => {
    /* The guarantee behind the test above: the binding is required per kind,
       so no future caller can publish a release that leaves the revision to
       be chosen by whoever receives it. */
    const { SalesHandoverOutboxEvent } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const w = await world();
    await expect(SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_release.authorised",
      occurredAt: new Date(),
      correlationId: `c-${uniq()}`,
      payload: {
        requestRef: "DR-X", journeyId: w.journey._id, productLineRef: w.productLineRef,
      },
    })).rejects.toThrow(/payload\.(developmentFileId|bomRevisionNo)/);
  });

  /* ── 7 ─────────────────────────────────────────────────────────────── */
  test("intake stores the transported revision on the file", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });

    const after = await fileFor(w);
    expect(after.lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect(after.releasedBomRevisionNo).toBe(1);

    const {
      MerchandisingAuditEvent,
    } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
    const audit = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, action: "DEVELOPMENT_RELEASED_BY_SALES",
    }).lean();
    expect(audit.details.bomRevisionNo).toBe(1);
    expect(String(audit.details.developmentFileId)).toBe(String(fileId));
  });

  /* ── 8 ─────────────────────────────────────────────────────────────── */
  test("intake refuses a stale binding rather than substituting the newer revision", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { fileId } = await approvedLine(w, c);
    const intake = require("../../services/merchandising/developmentIntake.service");
    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");

    /* Revision 2 is approved AFTER the release was authorised against 1 —
       exactly the window that asynchronous delivery opens. */
    await nextRevision(w, c, fileId, 1);
    expect((await fileFor(w)).currentBomRevisionNo).toBe(2);

    const event = await SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_release.authorised",
      occurredAt: new Date(),
      correlationId: `c-stale-${uniq()}`,
      payload: {
        requestRef: "DR-STALE", journeyId: w.journey._id, productLineRef: w.productLineRef,
        developmentFileId: fileId, bomRevisionNo: 1, releaseReference: "REL-stale",
      },
    });

    const out = await intake.receive(event);
    /* The old behaviour released revision 2 here and said so in the note. */
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/no approved revision 1/i);
    const after = await fileFor(w);
    expect(after.lifecycleStatus).toBe(LIFECYCLE.APPROVED);
    expect(after.releasedBomRevisionNo == null).toBe(true);
  });

  test("intake refuses a binding that names a different file", async () => {
    const w = await world();
    const c = await cast(w.co);
    await approvedLine(w, c);
    /* A file id that is not this line's. The handler resolves the file from
       the line identity it already trusts and then checks that the event
       agrees with it, so an id from anywhere else — another line, another
       journey, another company — fails the same comparison. */
    const foreignFileId = new mongoose.Types.ObjectId();

    const intake = require("../../services/merchandising/developmentIntake.service");
    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const event = await SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_release.authorised",
      occurredAt: new Date(),
      correlationId: `c-foreign-${uniq()}`,
      payload: {
        requestRef: "DR-FOREIGN", journeyId: w.journey._id, productLineRef: w.productLineRef,
        developmentFileId: foreignFileId, bomRevisionNo: 1, releaseReference: "REL-foreign",
      },
    });

    const out = await intake.receive(event);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/which is not/i);
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.APPROVED);
  });

  /* ── 9 ─────────────────────────────────────────────────────────────── */
  test("a duplicate click is one release and one intake", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);
    const body = { expectedBomRevisionNo: 1, idempotencyKey: "rel-same-key" };

    const first = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body,
    });
    const second = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    /* The SAME release, not a second one that happens to look alike. */
    expect(second.body.releaseReference).toBe(first.body.releaseReference);
    expect(second.body.correlationId).toBe(first.body.correlationId);
    expect(second.body.bomRevisionNo).toBe(1);

    expect(await releaseEvents(w.co)).toHaveLength(1);
    expect(await MerchandisingIntakeLedger.countDocuments({
      companyId: w.co._id, sourceKind: "sales.development_release.authorised",
    })).toBe(1);
  });

  test("two concurrent clicks bind one revision between them", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);
    const body = { expectedBomRevisionNo: 1 };

    const [a, b] = await Promise.all([
      sales(`/${requestRef}/authorise-release`, { ...at(w, c.salesApprover), method: "POST", body }),
      sales(`/${requestRef}/authorise-release`, { ...at(w, c.salesApprover), method: "POST", body }),
    ]);

    /* Whatever order they landed in, there is one release and both callers
       are told about the same one. */
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok).toHaveLength(2);
    expect(ok[0].body.releaseReference).toBe(ok[1].body.releaseReference);
    expect(await releaseEvents(w.co)).toHaveLength(1);

    const req = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(req.release.bomRevisionNo).toBe(1);
  });

  /* ── 10 ────────────────────────────────────────────────────────────── */
  test("the same idempotency key cannot be reused for a different revision", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);

    const first = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, idempotencyKey: "rel-k" },
    });
    expect(first.status).toBe(200);

    const reused = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 2, idempotencyKey: "rel-k" },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(reused.body.error.details.releasedBomRevisionNo).toBe(1);
    expect(await releaseEvents(w.co)).toHaveLength(1);
  });

  test("a revision Merchandising has not approved cannot be released after one that was", async () => {
    /* ── THIS REFUSAL MOVED, AND IMPROVED ──────────────────────────────
       Releasing revision 2 after revision 1 used to be refused as "already
       released", which was the right answer for the wrong reason — it said a
       line may be released once, and a line may be released as many times as
       the customer changes their mind. What actually stops this one is that
       revision 2 does not exist: nothing has been reopened, nothing has been
       approved, and the file is still sitting with R&D. */
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);
    await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, idempotencyKey: "rel-one" },
    });

    const again = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 2, idempotencyKey: "rel-two" },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DEVELOPMENT_NOT_AWAITING_SALES");
    expect(await releaseEvents(w.co)).toHaveLength(1);

    /* And going BACKWARDS is refused as what it is. */
    const backwards = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 0, idempotencyKey: "rel-three" },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_REQUIRED");
    expect(await releaseEvents(w.co)).toHaveLength(1);
  });
});

/* ══ 8 — A REVISION THAT HAS LEFT DRAFT IS FROZEN, INCLUDING ON THE WAY OUT ═ */

describe("a state change cannot carry new rows past the freeze", () => {
  async function approvedRevision(w, c) {
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", expectedRevision: 0 },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    return DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.APPROVED,
    });
  }

  /* ── 11 ────────────────────────────────────────────────────────────── */
  test("rows cannot be rewritten by a save that also supersedes the revision", async () => {
    const w = await world();
    const c = await cast(w.co);
    const approved = await approvedRevision(w, c);
    const was = approved.rows.map((r) => r.rawItemName);

    /* The hole this closes: the guard read a state change as evidence that
       the revision was still an editable draft, so one save could change the
       state AND the rows together. R&D and Costing would keep reading
       "revision 1", and revision 1 would no longer say what they priced. */
    approved.rows[0].rawItemName = "A different fabric entirely";
    approved.state = BOM_STATE.SUPERSEDED;
    approved.supersededByRevisionNo = 2;
    await expect(approved.save()).rejects.toThrow(/approved development BOM is frozen/i);

    const onDisk = await DevelopmentBomRevision.findById(approved._id).lean();
    expect(onDisk.rows.map((r) => r.rawItemName)).toEqual(was);
    expect(onDisk.state).toBe(BOM_STATE.APPROVED);
  });

  test("superseding on its own is still allowed", async () => {
    /* The guard must refuse the ROWS, not the transition — a revision that
       could never be superseded could never be replaced either. */
    const w = await world();
    const c = await cast(w.co);
    const approved = await approvedRevision(w, c);
    approved.state = BOM_STATE.SUPERSEDED;
    approved.supersededByRevisionNo = 2;
    approved.supersededAt = new Date();
    await expect(approved.save()).resolves.toBeTruthy();
  });

  test("a submitted revision is frozen on the way back to draft too", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", expectedRevision: 0 },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });

    const submitted2 = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    });
    submitted2.rows[0].rawItemName = "Swapped while being returned";
    submitted2.state = BOM_STATE.DRAFT;
    await expect(submitted2.save()).rejects.toThrow(/submitted development BOM is frozen/i);
  });

  /* ── 12 ────────────────────────────────────────────────────────────── */
  test("the legacy SampleStyle BOM gate is untouched by this chunk", async () => {
    /* Chunk A binds the development release. It deliberately does NOT retire
       the old approval path, because that path is still the only thing that
       satisfies the `materials -> rnd` gate. Retiring it here would strand
       every style. */
    const styleRoutes = fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/sampleStyles.js"), "utf8",
    );
    expect(styleRoutes).toMatch(/bomApproval\.status/);
    expect(fs.existsSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/sampleBomApproval.js"),
    )).toBe(true);

    /* And nothing in this chunk writes it. */
    const release = fs.readFileSync(
      path.join(__dirname, "../../services/sales/developmentRequest.service.js"), "utf8",
    );
    const intakeSrc = fs.readFileSync(
      path.join(__dirname, "../../services/merchandising/developmentIntake.service.js"), "utf8",
    );
    expect(release).not.toMatch(/bomApproval/);
    expect(intakeSrc).not.toMatch(/bomApproval/);
  });
});

/* ══ 9 — THE NUMBER IS THE COMPANY'S, AND A COLLISION IS NEVER "DELIVERED" ═

   `developmentNumber` was globally unique while it is allocated per company,
   so the SECOND company's first file of any year could not be created — and
   the intake reported that failure as a concurrent duplicate, which is a
   success. The Sales request stayed ISSUED with no Merchandising file behind
   it and nothing anywhere said so. */

describe("development numbering is company-scoped", () => {
  const intake = require("../../services/merchandising/developmentIntake.service");

  /* ── 1 ─────────────────────────────────────────────────────────────── */
  test("two companies each open MDV-YYYY-0001 for the same year", async () => {
    const a = await world();
    const ca = await cast(a.co);
    const b = await world();
    const cb = await cast(b.co);

    const askedA = await askForDevelopment(a, ca.salesApprover);
    expect(askedA.status).toBeLessThan(400);
    const askedB = await askForDevelopment(b, cb.salesApprover);
    expect(askedB.status).toBeLessThan(400);

    const fileA = await fileFor(a);
    const fileB = await fileFor(b);
    /* Both files exist — this is the assertion that used to be impossible. */
    expect(fileA).toBeTruthy();
    expect(fileB).toBeTruthy();

    const year = new Date().getUTCFullYear();
    expect(fileA.developmentNumber).toBe(`MDV-${year}-0001`);
    expect(fileB.developmentNumber).toBe(`MDV-${year}-0001`);
    expect(String(fileA.companyId)).not.toBe(String(fileB.companyId));
  });

  test("and the number still increments within one company", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);

    /* A second product line on the same journey is a second file. */
    const saved = await Enquiry.findById(w.enquiry._id).lean();
    const secondLine = String(saved.products[1].productLineRef);
    const asked = await sales(`/journeys/${w.journey._id}/lines/${secondLine}`, {
      ...at(w, c.salesApprover), method: "POST",
      body: {
        requirementSummary: "A second product on the same journey, for its own file.",
        requestedCategories: ["FABRIC"],
      },
    });
    expect(asked.status).toBeLessThan(400);

    const year = new Date().getUTCFullYear();
    const numbers = (await DevelopmentFile.find({ companyId: w.co._id }).lean())
      .map((f) => f.developmentNumber).sort();
    expect(numbers).toEqual([`MDV-${year}-0001`, `MDV-${year}-0002`]);
  });

  /* ── 2 ─────────────────────────────────────────────────────────────── */
  test("delivering the same event twice is idempotent and returns the existing file", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);

    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const issued = await SalesHandoverOutboxEvent.findOne({
      companyId: w.co._id, kind: "sales.development_request.issued",
    }).lean();

    /* Re-delivering the very same event: the ledger recognises it. */
    const again = await intake.receive(issued);
    expect(again.duplicate).toBe(true);
    expect(again.applied).toBe(false);

    /* One file, still the same one, unchanged. */
    const after = await DevelopmentFile.find({ companyId: w.co._id }).lean();
    expect(after).toHaveLength(1);
    expect(String(after[0]._id)).toBe(String(file._id));
    expect(after[0].developmentNumber).toBe(file.developmentNumber);
  });

  test("a second, DIFFERENT event for the same line is a duplicate of the file, not of the event", async () => {
    /* A distinct event id, so the ledger does not recognise it, but the same
       company + journey + product line. The line-identity index refuses the
       insert and THAT is a genuine duplicate: the work is already done. */
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const file = await fileFor(w);

    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const issued = await SalesHandoverOutboxEvent.findOne({
      companyId: w.co._id, kind: "sales.development_request.issued",
    }).lean();

    /* Force the create path by removing the file's line identity from the
       finder's reach is not possible — so drive the classifier directly with
       the shape the database produces. */
    const err = Object.assign(new Error("E11000"), {
      code: 11000,
      keyPattern: { companyId: 1, journeyId: 1, productLineRef: 1 },
      keyValue: { companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef },
    });
    const out = await intake.classifyDuplicate(err, issued);
    expect(out.duplicate).toBe(true);
    expect(out.note).toMatch(new RegExp(file.developmentNumber));
  });

  /* ── 3 ─────────────────────────────────────────────────────────────── */
  test("a number collision is NOT reported as a delivered duplicate", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover);
    const {
      SalesHandoverOutboxEvent,
    } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
    const issued = await SalesHandoverOutboxEvent.findOne({
      companyId: w.co._id, kind: "sales.development_request.issued",
    }).lean();

    /* The exact error the old global index produced. It used to come back as
       `{duplicate: true, outcome: "NOOP", note: "Delivered concurrently."}` —
       a write that failed, reported as a delivery that succeeded. */
    const err = Object.assign(new Error("E11000"), {
      code: 11000,
      keyPattern: { developmentNumber: 1 },
      keyValue: { developmentNumber: "MDV-2026-0001" },
    });
    await expect(intake.classifyDuplicate(err, issued)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  test("an unrecognised duplicate key is surfaced rather than swallowed", async () => {
    const w = await world();
    const err = Object.assign(new Error("E11000"), {
      code: 11000, keyPattern: { somethingElse: 1 }, keyValue: { somethingElse: "x" },
    });
    await expect(intake.classifyDuplicate(err, {
      companyId: w.co._id, payload: { journeyId: w.journey._id, productLineRef: w.productLineRef },
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("the schema no longer declares a global unique number", () => {
    const declared = DevelopmentFile.schema.indexes()
      .map(([key, opts]) => ({ key: Object.keys(key).join("+"), unique: Boolean(opts.unique) }));
    expect(declared).toContainEqual({ key: "companyId+developmentNumber", unique: true });
    expect(DevelopmentFile.schema.path("developmentNumber").options.unique).toBeFalsy();
  });
});

/* ══ 10 — SALES REVIEWS THE SELECTION, AND MAY SEND IT BACK ════════════════

   The release was the only answer Sales had. Approving was therefore the only
   way to make the screen move, which is not a decision — it is a dead end
   with a button on it. Sales now answers a revision one of two ways, and both
   answers name the exact revision they answer. */

describe("Sales can approve the selection or send it back", () => {
  const intake = require("../../services/merchandising/developmentIntake.service");
  const {
    SalesHandoverOutboxEvent,
  } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");

  /** Ask → accept → one row with every published field → submit → approve. */
  async function approvedLine(w, c, over = {}) {
    const asked = await askForDevelopment(w, c.salesApprover);
    const requestRef = asked.body.request.requestRef;
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        category: "FABRIC", rawItemName: "Pique 180gsm", rawItemSku: "FB-PQ-180",
        colourOrShade: "Navy 19-4025", finish: "Enzyme wash", placement: "Body",
        appliesTo: "All sizes", selectionNote: "Closest match to the approved lab dip.",
        expectedRevision: 0, ...over,
      },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    return { requestRef, fileId: file._id };
  }

  const sendBack = (w, who, ref, body) => sales(`/${ref}/request-material-changes`, {
    ...at(w, who), method: "POST", body,
  });
  const REASON = "The buyer rejected navy; they confirmed black for the whole order.";
  const changeEvents = (co) => SalesHandoverOutboxEvent.find({
    companyId: co._id, kind: "sales.development_changes.requested",
  }).lean();
  const releaseEvents = (co) => SalesHandoverOutboxEvent.find({
    companyId: co._id, kind: "sales.development_release.authorised",
  }).lean();

  /* ── 4 ─────────────────────────────────────────────────────────────── */
  test("Sales sees every published field of the exact approved revision", async () => {
    const w = await world();
    const c = await cast(w.co);
    await approvedLine(w, c);

    const view = await sales(`/journeys/${w.journey._id}`, at(w, c.salesApprover));
    expect(view.status).toBe(200);
    const line = view.body.merchandising[w.productLineRef];

    expect(line.approvedRevisionNo).toBe(1);
    expect(line.releaseAwaitingSales).toBe(true);
    expect(line.selectedMaterials).toHaveLength(1);
    expect(line.selectedMaterials[0]).toEqual({
      category: "FABRIC",
      name: "Pique 180gsm",
      reference: "FB-PQ-180",
      colourOrShade: "Navy 19-4025",
      finish: "Enzyme wash",
      placement: "Body",
      appliesTo: "All sizes",
      selectionNote: "Closest match to the approved lab dip.",
    });

    /* Who stood behind it inside Merchandising, so Sales is reviewing a named
       department's decision rather than an anonymous list. */
    expect(line.preparedByName).toBeTruthy();
    expect(line.submittedByName).toBeTruthy();
    expect(line.approvedByName).toBeTruthy();
    expect(line.submittedAt).toBeTruthy();
    expect(line.approvedAt).toBeTruthy();
    /* And still no handle on the file. */
    expect(line).not.toHaveProperty("developmentFileId");
  });

  /* ── 5 ─────────────────────────────────────────────────────────────── */
  test("approving goes through the exact-revision release path", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);

    const ok = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.bomRevisionNo).toBe(1);
    const [event] = await releaseEvents(w.co);
    expect(String(event.payload.developmentFileId)).toBe(String(fileId));
    expect(event.payload.bomRevisionNo).toBe(1);
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
  });

  /* ── 6 ─────────────────────────────────────────────────────────────── */
  test("sending it back requires a reason a merchandiser can act on", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);

    for (const reason of [undefined, "", "   ", "too dark"]) {
      const res = await sendBack(w, c.salesApprover, requestRef, {
        expectedBomRevisionNo: 1, ...(reason === undefined ? {} : { reason }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.minimum).toBe(15);
    }
    expect(await changeEvents(w.co)).toHaveLength(0);
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.APPROVED);

    /* And it also has to name the revision it answers. */
    const unnamed = await sendBack(w, c.salesApprover, requestRef, { reason: REASON });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_REQUIRED");
  });

  /* ── 7 ─────────────────────────────────────────────────────────────── */
  test("a Sales decision cannot carry material facts", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);

    for (const field of ["rows", "rawItemName", "colourOrShade", "selectionNote", "materials"]) {
      const res = await sendBack(w, c.salesApprover, requestRef, {
        expectedBomRevisionNo: 1, reason: REASON, [field]: "black",
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("DEVELOPMENT_MATERIALS_NOT_EDITABLE");
      expect(res.body.error.details.field).toBe(field);
      expect(res.body.message).toMatch(/Merchandising/);
    }
    /* The release refuses them on exactly the same terms. */
    const onRelease = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, rawItemName: "Something else" },
    });
    expect(onRelease.status).toBe(422);
    expect(await changeEvents(w.co)).toHaveLength(0);
    expect(await releaseEvents(w.co)).toHaveLength(0);
  });

  /* ── 8 ─────────────────────────────────────────────────────────────── */
  test("a revision approved since the panel loaded refuses the send-back", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);

    /* Merchandising raises and approves revision 2. */
    await call(`/development/${fileId}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { fromRevisionNo: 1 },
    });
    let draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "TRIM", rawItemName: "Horn button", expectedRevision: draft.revision },
    });
    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${fileId}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });

    const stale = await sendBack(w, c.salesApprover, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("DEVELOPMENT_BOM_REVISION_CHANGED");
    expect(stale.body.error.details.currentBomRevisionNo).toBe(2);

    /* Nothing moved. */
    expect(await changeEvents(w.co)).toHaveLength(0);
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.APPROVED);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(0);
  });

  /* ── 9 ─────────────────────────────────────────────────────────────── */
  test("a viewer and a foreign company are both refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);

    const viewer = await sendBack(w, c.salesViewer, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(viewer.status).toBe(403);

    /* A Merchandising seat is not a Sales decision, however senior. */
    const merch = await sendBack(w, c.owner, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(merch.status).toBe(403);

    const other = await world();
    const co = await cast(other.co);
    const foreign = await sendBack(other, co.salesApprover, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("DEVELOPMENT_REQUEST_NOT_FOUND");

    expect(await changeEvents(w.co)).toHaveLength(0);
    expect(await changeEvents(other.co)).toHaveLength(0);
  });

  /* ── 10 + 11 ───────────────────────────────────────────────────────── */
  test("the approved revision is untouched and the successor is not Sales' work", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    const before = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, revisionNo: 1,
    }).lean();

    const res = await sendBack(w, c.salesApprover, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(res.status).toBe(200);
    expect(res.body.bomRevisionNo).toBe(1);

    /* ── HISTORY DOES NOT MOVE ──────────────────────────────────────── */
    const after = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, revisionNo: 1,
    }).lean();
    expect(after.state).toBe(BOM_STATE.APPROVED);
    expect(after.rows.map((r) => r.rawItemName)).toEqual(before.rows.map((r) => r.rawItemName));
    expect(String(after.approvedBy?.name)).toBe(String(before.approvedBy?.name));
    expect(after.approvedAt).toEqual(before.approvedAt);

    /* ── AND THE SUCCESSOR IS MERCHANDISING'S TO AUTHOR ─────────────── */
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    expect(draft.revisionNo).toBe(2);
    expect(draft.clonedFromRevisionNo).toBe(1);
    expect(draft.rows.map((r) => r.rawItemName)).toEqual(before.rows.map((r) => r.rawItemName));
    /* Sales asked; Sales did not choose these materials. */
    expect(draft.createdBy?.id).toBeFalsy();
    expect(draft.createdBy?.name).toBeFalsy();
    expect(draft.submittedBy?.id).toBeFalsy();
    /* What Sales DID is recorded, and attributed to them. */
    expect(draft.changesRequestedBy?.name).toBeTruthy();
    expect(draft.changeReason).toBe(REASON);
  });

  /* ── 12 ────────────────────────────────────────────────────────────── */
  test("Merchandising sees the reason, and the file is actionable again", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    await sendBack(w, c.salesApprover, requestRef, { expectedBomRevisionNo: 1, reason: REASON });

    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.ACTIVE);
    expect(file.lifecycleReason).toMatch(/Sales asked for changes to revision 1/);

    /* On Merchandising's own read of the file. */
    const view = await call(`/development/${fileId}`, at(w, c.editor));
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).toMatch(new RegExp(REASON.slice(0, 30)));

    /* And in the audit trail, attributed to Sales. */
    const {
      MerchandisingAuditEvent,
    } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
    const audit = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, action: "DEVELOPMENT_CHANGES_REQUESTED_BY_SALES",
    }).lean();
    expect(audit.source).toBe("sales");
    expect(audit.reason).toBe(REASON);
    expect(audit.details.reviewedBomRevisionNo).toBe(1);
    expect(audit.details.openedBomRevisionNo).toBe(2);
  });

  test("and Sales sees the successor once Merchandising approves it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    await sendBack(w, c.salesApprover, requestRef, { expectedBomRevisionNo: 1, reason: REASON });

    /* Merchandising revises the successor and puts it through maker/checker. */
    let draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        category: "FABRIC", rawItemName: "Pique 180gsm black", colourOrShade: "Black 19-4005",
        expectedRevision: draft.revision,
      },
    });
    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${fileId}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });

    const view = await sales(`/journeys/${w.journey._id}`, at(w, c.salesApprover));
    const line = view.body.merchandising[w.productLineRef];
    expect(line.approvedRevisionNo).toBe(2);
    expect(line.releaseAwaitingSales).toBe(true);
    expect(line.selectedMaterials.map((r) => r.colourOrShade)).toContain("Black 19-4005");
    /* Revision 1 is history, superseded, not deleted. */
    const one = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, revisionNo: 1,
    }).lean();
    expect(one.state).toBe(BOM_STATE.SUPERSEDED);
    expect(one.supersededByRevisionNo).toBe(2);

    /* And releasing now binds revision 2. */
    const ok = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 2 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.bomRevisionNo).toBe(2);
  });

  /* ── 13 ────────────────────────────────────────────────────────────── */
  test("a duplicate send-back opens one successor, not two", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    const body = { expectedBomRevisionNo: 1, reason: REASON, idempotencyKey: "chg-1" };

    const first = await sendBack(w, c.salesApprover, requestRef, body);
    const second = await sendBack(w, c.salesApprover, requestRef, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.correlationId).toBe(first.body.correlationId);

    expect(await changeEvents(w.co)).toHaveLength(1);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(1);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId,
    })).toBe(2);
  });

  test("re-delivering the same decision opens no second draft", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await approvedLine(w, c);
    await sendBack(w, c.salesApprover, requestRef, { expectedBomRevisionNo: 1, reason: REASON });

    const [event] = await changeEvents(w.co);
    const again = await intake.receive(event);
    expect(again.duplicate).toBe(true);

    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId,
    })).toBe(2);
  });

  /* ── 14 ────────────────────────────────────────────────────────────── */
  test("approving and sending back cannot both win", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);

    const [a, b] = await Promise.all([
      sales(`/${requestRef}/authorise-release`, {
        ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
      }),
      sendBack(w, c.salesApprover, requestRef, { expectedBomRevisionNo: 1, reason: REASON }),
    ]);

    const won = [a, b].filter((r) => r.status === 200);
    const lost = [a, b].filter((r) => r.status !== 200);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(["DEVELOPMENT_ALREADY_RELEASED", "DEVELOPMENT_CHANGES_ALREADY_REQUESTED", "CONFLICT"])
      .toContain(lost[0].body.error.code);

    /* Exactly one of the two events exists. */
    const events = [...(await releaseEvents(w.co)), ...(await changeEvents(w.co))];
    expect(events).toHaveLength(1);
  });

  test("a release already delivered is a named conflict, not a rewind", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);
    await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);

    const res = await sendBack(w, c.salesApprover, requestRef, {
      expectedBomRevisionNo: 1, reason: REASON,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVELOPMENT_ALREADY_RELEASED");
    expect(res.body.message).toMatch(/R&D is working against it/);
    /* The release stands, exactly as it was. */
    expect((await fileFor(w)).lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect((await fileFor(w)).releasedBomRevisionNo).toBe(1);
    expect(await changeEvents(w.co)).toHaveLength(0);
  });

  test("intake refuses a send-back that names a different file", async () => {
    /* The same guard the release intake applies, on the same terms: the
       handler resolves the file from the line identity it already trusts, and
       then checks the event agrees with it. An id from another line, journey
       or company fails the same comparison — and must not reopen a revision
       on a file nobody named. */
    const w = await world();
    const c = await cast(w.co);
    const { fileId } = await approvedLine(w, c);

    const event = await SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_changes.requested",
      occurredAt: new Date(),
      correlationId: `c-foreign-chg-${uniq()}`,
      payload: {
        requestRef: "DR-FOREIGN", journeyId: w.journey._id, productLineRef: w.productLineRef,
        developmentFileId: new mongoose.Types.ObjectId(),
        bomRevisionNo: 1, reason: REASON,
      },
    });

    const out = await intake.receive(event);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/which is not/i);

    /* Nothing reopened: still approved, still one revision. */
    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.APPROVED);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId,
    })).toBe(1);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(0);
  });

  /* ── 15 ────────────────────────────────────────────────────────────── */
  test("sending it back creates no R&D release", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await approvedLine(w, c);
    await sendBack(w, c.salesApprover, requestRef, { expectedBomRevisionNo: 1, reason: REASON });

    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.ACTIVE);
    expect(file.releasedToRndAt).toBeFalsy();
    expect(file.releasedBomRevisionNo == null).toBe(true);
    expect(file.releaseReference).toBe("");
    expect(await releaseEvents(w.co)).toHaveLength(0);
    expect(await MerchandisingIntakeLedger.countDocuments({
      companyId: w.co._id, sourceKind: "sales.development_release.authorised",
    })).toBe(0);
  });
});

/* ══ 11 — A RELEASE IS A DECISION, AND DECISIONS GO OUT OF DATE ═══════════

   Sales released revision 1 and R&D started building. The customer then
   changed their mind, Merchandising approved revision 2, and nothing anywhere
   said that what R&D was holding had been replaced — the shortlist simply
   started returning the newer rows, and the release still read as current.

   Nothing here deletes anything. The old release, the old approved revision
   and R&D's work against it all stay exactly as they are; what changes is
   that they stop being able to AUTHORISE anything new. */

describe("a superseded release is history, not authority", () => {
  const intake = require("../../services/merchandising/developmentIntake.service");
  const publication = require("../../services/merchandising/developmentPublication.service");
  const {
    SalesHandoverOutboxEvent,
  } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
  const REASON = "The buyer rejected navy after the sample; they confirmed black.";

  async function approvedLine(w, c) {
    const asked = await askForDevelopment(w, c.salesApprover);
    const requestRef = asked.body.request.requestRef;
    const file = await fileFor(w);
    await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
    await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
    await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", colourOrShade: "Navy", expectedRevision: 0 },
    });
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    }).lean();
    await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    return { requestRef, fileId: file._id };
  }

  /** Released revision 1, with R&D holding it. */
  async function released(w, c) {
    const out = await approvedLine(w, c);
    const res = await sales(`/${out.requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body: { expectedBomRevisionNo: 1 },
    });
    expect(res.status).toBe(200);
    return out;
  }

  /** Sales reopens the released line at the customer's request. */
  const reopen = (w, who, ref, over = {}) => sales(`/${ref}/request-material-changes`, {
    ...at(w, who), method: "POST",
    body: { expectedBomRevisionNo: 1, reason: REASON, reopenReleased: true, ...over },
  });

  /** Merchandising revises and approves the open draft. */
  async function approveSuccessor(w, c, fileId) {
    let draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: { category: "FABRIC", rawItemName: "Pique 180gsm", colourOrShade: "Black", expectedRevision: draft.revision },
    });
    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    await call(`/development/${fileId}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { expectedRevision: draft.revision },
    });
    const sub = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.SUBMITTED,
    }).lean();
    const res = await call(`/development/${fileId}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(), body: { expectedRevision: sub.revision },
    });
    expect(res.status).toBe(200);
  }

  const lineOf = async (w, c) => (await sales(`/journeys/${w.journey._id}`,
    at(w, c.salesApprover))).body.merchandising[w.productLineRef];

  /* ── 1 ─────────────────────────────────────────────────────────────── */
  test("an open successor draft alone does not make the release stale", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    await reopen(w, c.salesApprover, requestRef);

    /* A draft exists and revision 1 is still the approved selection, so the
       release still describes what is in force. Somebody is WORKING on a
       replacement; nobody has agreed one. */
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    expect(draft.revisionNo).toBe(2);

    const line = await lineOf(w, c);
    expect(line.materialApproval.state).toBe("CURRENT");
    expect(line.materialApproval.stale).toBe(false);
    expect(line.materialApproval.releasedRevisionNo).toBe(1);
    expect(line.materialApproval.currentRevisionNo).toBe(1);

    /* And the release on the request is untouched. */
    const req = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(req.release.bomRevisionNo).toBe(1);
    expect(req.releases).toHaveLength(1);
  });

  /* ── 2 + 3 ─────────────────────────────────────────────────────────── */
  test("approving the successor makes it stale, and the old decision stays readable", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    const before = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();

    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    const line = await lineOf(w, c);
    expect(line.materialApproval.state).toBe("STALE");
    expect(line.materialApproval.releasedRevisionNo).toBe(1);
    expect(line.materialApproval.currentRevisionNo).toBe(2);
    expect(line.materialApprovalOutOfDate).toBe(true);
    /* The newer revision is the one awaiting Sales. */
    expect(line.approvedRevisionNo).toBe(2);
    expect(line.releaseAwaitingSales).toBe(true);

    /* ── NOTHING WAS DELETED ─────────────────────────────────────────── */
    const after = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(after.release.bomRevisionNo).toBe(1);
    expect(after.release.releaseReference).toBe(before.release.releaseReference);
    expect(after.release.authorisedAt).toEqual(before.release.authorisedAt);
    expect(String(after.release.authorisedBy?.name)).toBe(String(before.release.authorisedBy?.name));
    expect(after.releases[0].bomRevisionNo).toBe(1);

    /* Revision 1 is superseded, kept, and still carries its own rows. */
    const one = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, revisionNo: 1,
    }).lean();
    expect(one.state).toBe(BOM_STATE.SUPERSEDED);
    expect(one.rows.map((r) => r.colourOrShade)).toContain("Navy");
    expect(one.approvedAt).toBeTruthy();

    /* And the file still records the release it made. */
    const file = await fileFor(w);
    expect(file.releasedBomRevisionNo).toBe(1);
    expect(file.releasedToRndAt).toBeTruthy();
    expect(file.releaseReference).toMatch(/^REL-/);
  });

  /* ── 4 ─────────────────────────────────────────────────────────────── */
  test("Sales is shown the old revision and the new one, never the old as current", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);

    const current = await lineOf(w, c);
    expect(current.materialApproval.state).toBe("CURRENT");
    expect(current.releasedBomRevisionNo).toBe(1);

    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    const stale = await lineOf(w, c);
    expect(stale.releasedBomRevisionNo).toBe(1);
    expect(stale.approvedRevisionNo).toBe(2);
    /* The reason the work reopened is carried through to the screen. */
    expect(stale.selectedMaterials.map((m) => m.colourOrShade)).toContain("Black");
  });

  /* ── 5 + 11 ────────────────────────────────────────────────────────── */
  test("Sales approves the successor as a new decision, and a repeat replays", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    const body = { expectedBomRevisionNo: 2, idempotencyKey: "rel-two" };
    const first = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body,
    });
    expect(first.status).toBe(200);
    expect(first.body.bomRevisionNo).toBe(2);

    const again = await sales(`/${requestRef}/authorise-release`, {
      ...at(w, c.salesApprover), method: "POST", body,
    });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.releaseReference).toBe(first.body.releaseReference);

    /* TWO releases on the record, the first one intact. */
    const req = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(req.releases.map((r) => r.bomRevisionNo)).toEqual([1, 2]);
    expect(req.releases[1].supersedesBomRevisionNo).toBe(1);
    expect(req.release.bomRevisionNo).toBe(2);
    expect(req.releases[0].releaseReference).not.toBe(req.releases[1].releaseReference);

    /* Current again, and R&D now holds revision 2. */
    const line = await lineOf(w, c);
    expect(line.materialApproval.state).toBe("CURRENT");
    expect((await fileFor(w)).releasedBomRevisionNo).toBe(2);
  });

  /* ── 6 ─────────────────────────────────────────────────────────────── */
  test("Sales can send the successor back instead of approving it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    const res = await sales(`/${requestRef}/request-material-changes`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 2, reason: "Black is right but the buyer wants a matt finish." },
    });
    expect(res.status).toBe(200);
    expect(res.body.bomRevisionNo).toBe(2);

    /* Revision 3 opens; the release of revision 1 is still on the record. */
    const draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    }).lean();
    expect(draft.revisionNo).toBe(3);
    expect(draft.changesRequestedSource).toBe("SALES");
    const req = await SalesDevelopmentRequest.findOne({ companyId: w.co._id, requestRef }).lean();
    expect(req.releases.map((r) => r.bomRevisionNo)).toEqual([1]);
  });

  /* ── 7 + 8 ─────────────────────────────────────────────────────────── */
  test("a delayed release event for the old revision cannot refresh intake", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    /* An event for revision 1, arriving now. Revision 1 is SUPERSEDED, so
       there is nothing approved for it to release. */
    const late = await SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_release.authorised",
      occurredAt: new Date(Date.now() - 60000),
      correlationId: `c-late-${uniq()}`,
      payload: {
        requestRef, journeyId: w.journey._id, productLineRef: w.productLineRef,
        developmentFileId: fileId, bomRevisionNo: 1, releaseReference: "REL-late",
      },
    });
    const out = await intake.receive(late);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/no approved revision 1/i);

    /* The file is NOT pushed back to released, and still records the
       historical release of revision 1. */
    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.APPROVED);
    expect(file.releasedBomRevisionNo).toBe(1);
    expect(file.releaseReference).not.toBe("REL-late");
  });

  /* ── 9 ─────────────────────────────────────────────────────────────── */
  test("new R&D work is blocked with a named stale-material reason", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);

    const shortlist = require("../../services/approvedMaterialShortlist.service");
    const style = await SampleStyle.findById(w.style._id).lean();

    /* While current: R&D reads the released revision and is not blocked. */
    const ok = await shortlist.approvedShortlistFor(style);
    expect(ok.source).toBe("DEVELOPMENT_BOM");
    expect(ok.developmentBomRevisionNo).toBe(1);
    expect(ok.blocker).toBeNull();

    await reopen(w, c.salesApprover, requestRef);
    await approveSuccessor(w, c, fileId);

    const blocked = await shortlist.approvedShortlistFor(style);
    /* ── R&D STILL SEES WHAT THEY BUILT AGAINST ─────────────────────── */
    expect(blocked.developmentBomRevisionNo).toBe(1);
    expect(blocked.rows.map((r) => r.colourOrShade ?? r.variantLabels)).toBeDefined();
    /* ── AND CANNOT ADD TO IT AS CURRENT ────────────────────────────── */
    expect(blocked.blocker).toBeTruthy();
    expect(blocked.blocker.code).toBe("DEVELOPMENT_MATERIALS_STALE");
    expect(blocked.blocker.owner).toBe("SALES");
    expect(blocked.blocker.releasedBomRevisionNo).toBe(1);
    expect(blocked.blocker.currentBomRevisionNo).toBe(2);
    expect(blocked.blocker.message).toMatch(/Sales reviews and releases/);

    /* What this lane owns is the BLOCKER — its code, its owner and the facts
       it carries. That the R&D completeness gate refuses a submission holding
       one is Costing's own contract, and is pinned in
       `test/costing/rnd-technical-record.test.js`. Requiring Costing's module
       from a Merchandising test would put its load graph behind this suite,
       which is exactly what `costing-boundary.test.js` forbids. */
    expect(Object.keys(blocked.blocker).sort()).toEqual([
      "code", "currentBomRevisionNo", "field", "message", "owner", "releasedBomRevisionNo",
    ]);
  });

  /* ── 10 ────────────────────────────────────────────────────────────── */
  test("staleness is derived from one file, so no foreign number can create it", async () => {
    /* Both halves of the comparison come from the SAME file document. A
       revision number belonging to another company's file is not reachable,
       because nothing is ever looked up by it. */
    const a = publication.materialApprovalOf(
      { releasedBomRevisionNo: 1, currentBomRevisionNo: 1 }, { revisionNo: 1 },
    );
    expect(a.state).toBe("CURRENT");
    const b = publication.materialApprovalOf(
      { releasedBomRevisionNo: 1, currentBomRevisionNo: 2 }, { revisionNo: 2 },
    );
    expect(b.state).toBe("STALE");
    const none = publication.materialApprovalOf(
      { releasedBomRevisionNo: null, currentBomRevisionNo: 5 }, { revisionNo: 5 },
    );
    expect(none.state).toBe("NOT_RELEASED");
    expect(none.stale).toBe(false);

    /* And a foreign caller cannot reopen or approve anything. */
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await released(w, c);
    const other = await world();
    const co = await cast(other.co);
    const foreign = await reopen(other, co.salesApprover, requestRef);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("DEVELOPMENT_REQUEST_NOT_FOUND");
  });

  /* ── 12 ────────────────────────────────────────────────────────────── */
  test("two competing successors cannot both become current", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);
    await reopen(w, c.salesApprover, requestRef);

    /* A second draft is refused by the database, not by a handler. */
    const second = await call(`/development/${fileId}/bom`, {
      ...at(w, c.editor), method: "POST", key: uniq(), body: { fromRevisionNo: 1 },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(1);

    await approveSuccessor(w, c, fileId);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.APPROVED,
    })).toBe(1);
  });

  /* ── 13 ────────────────────────────────────────────────────────────── */
  test("a reopen opens exactly the one line it names", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);

    /* A second product line on the same journey, with its own file. */
    const saved = await Enquiry.findById(w.enquiry._id).lean();
    const otherLine = String(saved.products[1].productLineRef);
    await sales(`/journeys/${w.journey._id}/lines/${otherLine}`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { requirementSummary: "A separate product with its own development file.", requestedCategories: ["FABRIC"] },
    });
    const otherFile = await DevelopmentFile.findOne({
      companyId: w.co._id, journeyId: w.journey._id, productLineRef: otherLine,
    }).lean();
    expect(String(otherFile._id)).not.toBe(String(fileId));

    await reopen(w, c.salesApprover, requestRef);

    /* Only the named line has a draft. */
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(1);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: otherFile._id,
    })).toBe(0);
    expect((await DevelopmentFile.findById(otherFile._id).lean()).lifecycleStatus).toBe(LIFECYCLE.NEW);
  });

  test("a reopen event naming the wrong released revision reopens nothing", async () => {
    /* `resolveReopenBinding` refuses this at the Sales boundary, so an event
       like this can only arrive from a replay of something older or a forged
       payload. The receiver checks it again anyway: it is the last thing
       between a bad identity and a reopened file, and it verifies against the
       file's OWN record of what it released rather than trusting the event. */
    const w = await world();
    const c = await cast(w.co);
    const { fileId } = await released(w, c);

    const event = await SalesHandoverOutboxEvent.create({
      companyId: w.co._id,
      kind: "sales.development_changes.requested",
      occurredAt: new Date(),
      correlationId: `c-wrong-rev-${uniq()}`,
      payload: {
        requestRef: "DR-WRONG", journeyId: w.journey._id, productLineRef: w.productLineRef,
        developmentFileId: fileId,
        /* Revision 7 was never released — revision 1 was. */
        bomRevisionNo: 7, reason: REASON, reopenReleased: true,
      },
    });

    const out = await intake.receive(event);
    expect(out.outcome).toBe("NOOP");
    expect(out.note).toMatch(/released revision 1/i);

    /* Still released, still no draft, release untouched. */
    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect(file.releasedBomRevisionNo).toBe(1);
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(0);
  });

  /* ── 14 ────────────────────────────────────────────────────────────── */
  test("Merchandising cannot reopen released work on its own", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef, fileId } = await released(w, c);

    /* Every rung, including the owner. Reopening is a commercial decision. */
    for (const who of [c.editor, c.approver, c.owner]) {
      const res = await call(`/development/${fileId}/bom`, {
        ...at(w, who), method: "POST", key: uniq(), body: { fromRevisionNo: 1 },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("DEVELOPMENT_RELEASE_IS_SALES");
      expect(res.body.message).toMatch(/Sales reopens the line/);
    }

    /* Nothing opened, and the release is untouched. */
    expect(await DevelopmentBomRevision.countDocuments({
      companyId: w.co._id, developmentFileId: fileId, state: BOM_STATE.DRAFT,
    })).toBe(0);
    const file = await fileFor(w);
    expect(file.lifecycleStatus).toBe(LIFECYCLE.RELEASED_TO_RND);
    expect(file.releasedBomRevisionNo).toBe(1);

    /* And the authorised path works from the same starting point. */
    const ok = await reopen(w, c.salesApprover, requestRef);
    expect(ok.status).toBe(200);
    expect(ok.body.reopenedRelease).toBe(true);
  });

  test("a reopen must say it is one, and a review must not", async () => {
    const w = await world();
    const c = await cast(w.co);
    const { requestRef } = await released(w, c);

    /* Reopening by accident is the thing this prevents: an ordinary review
       decision against a released line is refused and told how to say it. */
    const bare = await sales(`/${requestRef}/request-material-changes`, {
      ...at(w, c.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, reason: REASON },
    });
    expect(bare.status).toBe(409);
    expect(bare.body.error.code).toBe("DEVELOPMENT_ALREADY_RELEASED");
    expect(bare.body.error.details.reopenWith).toBe("reopenReleased");

    /* And claiming a reopen where nothing was released is refused too. */
    const w2 = await world();
    const c2 = await cast(w2.co);
    const { requestRef: ref2 } = await approvedLine(w2, c2);
    const notReleased = await sales(`/${ref2}/request-material-changes`, {
      ...at(w2, c2.salesApprover), method: "POST",
      body: { expectedBomRevisionNo: 1, reason: REASON, reopenReleased: true },
    });
    expect(notReleased.status).toBe(409);
    expect(notReleased.body.error.code).toBe("DEVELOPMENT_NOT_RELEASED");
  });
});
