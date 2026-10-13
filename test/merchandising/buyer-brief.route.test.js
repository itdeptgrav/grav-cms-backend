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
  /* ── A LAUNCH TIMEOUT THAT SURVIVES A BUSY MACHINE ───────────────────
     The default is ten seconds, which this suite exceeded whenever another
     test run held the machine — and every test then failed with "instance
     failed to start" rather than on anything it was testing. A slow start is
     not a defect in the code under test, so it is given room. */
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ launchTimeout: 90000 }],
  });
  /* ── TIMEOUTS THAT SURVIVE A BUSY MACHINE ────────────────────────────
     The driver's default heartbeat gave up while another test run held the
     machine, which cleared the pool and failed every test with
     "PoolClearedOnNetworkError" rather than on anything under test. A slow
     reply is not a defect in the code, so the monitor is given room. */
  await mongoose.connect(rs.getUri(), {
    dbName: "buyer_brief",
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 120000,
    heartbeatFrequencyMS: 30000,
  });
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


/* ══════════════════════════════════════════════════════════════════════════
   THE BUYER BRIEF: THE WIRING, END TO END
   ══════════════════════════════════════════════════════════════════════════

   The RULES — carry-forward, validation, the labels and the absence sentences
   — are pure functions and are tested as values in `buyer-brief-rules.test.js`.
   Proving them through an HTTP route and a replica set tested the same
   arithmetic through thirty writes a case: slower, and a failure said "400"
   rather than which rule broke.

   What is left here is what only a real request can show: that Sales' door
   accepts the brief, that it is stored on the versioned request, that
   Merchandising's read returns it, that a correction through the real door
   keeps it, and that no door in Merchandising can change it.                */

/** Everything a full brief says, as the Sales form posts it. */
const FULL_BRIEF = Object.freeze({
  targetPriceCeiling: { amount: 850, currency: "INR", basis: "PER_PIECE" },
  customerDirection: {
    market: { choice: "UK" },
    season: { choice: "RESORT", year: 2027 },
    intendedUse: { choice: "RESORT_HOLIDAY" },
    targetCustomer: "men 30-45, premium UK high street",
  },
  productDirection: {
    fit: { choice: "RELAXED", note: "camp collar, straight hem" },
    fabric: { values: ["LINEN"], note: "textured" },
    composition: "majority natural fibre",
    weightOrFeel: "soft hand",
    coloursWanted: "warm ivory, not optic white",
    performance: { values: ["BREATHABLE", "OPAQUE"] },
    trimsAndBranding: "natural coconut-look buttons, tonal stitching",
    avoid: "avoid excessive transparency",
  },
  developmentNeed: {
    sampleType: { choice: "PROTO" },
    sampleQuantity: 2,
    sampleSizes: ["M"],
    samplePackaging: "recyclable sample packaging",
    printing: { state: "NOT_REQUIRED" },
    embroidery: { state: "REQUIRED", detail: "chest logo, tonal thread" },
    washFinish: { state: "NOT_CONFIRMED" },
    testing: { values: ["SHRINKAGE"] },
    certification: { values: ["OEKO_TEX"] },
    sustainability: { values: ["RECYCLABLE_PACKAGING"] },
  },
  referenceImages: [
    { url: "https://res.cloudinary.com/demo/p.jpg", caption: "front", referenceType: "PRODUCT", storageRef: "cl-p" },
    { url: "https://res.cloudinary.com/demo/t.jpg", caption: "buttons", referenceType: "TRIM", storageRef: "cl-t" },
  ],
});

/** The file Merchandising reads, and the server-built brief on it. */
async function briefFor(w, actorOf) {
  const file = await fileFor(w);
  const res = await call(`/development/${file._id}`, at(w, actorOf));
  expect(res.status).toBe(200);
  return res.body;
}

describe("Sales authors it, Merchandising reads it", () => {
  test("a full brief is accepted, stored on the version, and read back labelled", async () => {
    const w = await world();
    const c = await cast(w.co);
    const asked = await sales(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
      ...at(w, c.salesApprover), method: "POST",
      body: {
        requirementSummary: "A relaxed linen resort shirt for the UK summer drop.",
        requestedCategories: ["FABRIC", "TRIMS"],
        requiredByDate: "2027-01-15",
        ...FULL_BRIEF,
      },
    });
    expect(asked.status === 201 ? "created" : JSON.stringify(asked.body)).toBe("created");

    /* Stored on the versioned request, as keys. */
    const stored = await SalesDevelopmentRequest
      .findOne({ companyId: w.co._id, productLineRef: w.productLineRef, versionNo: 1 }).lean();
    expect(stored.targetPriceCeiling).toMatchObject({ amount: 850, currency: "INR" });
    expect(stored.productDirection.fit.choice).toBe("RELAXED");
    expect(stored.developmentNeed.embroidery.detail).toBe("chest logo, tonal thread");

    /* Read by Merchandising, as words. */
    const { buyerBrief: b } = await briefFor(w, c.owner);
    expect(b.commercial.targetPrice.display).toBe("₹850 per piece");
    expect(b.customerDirection.market.value).toBe("United Kingdom");
    expect(b.productDirection.fit.value).toBe("Relaxed");
    expect(b.productDirection.avoid.value).toBe("avoid excessive transparency");
    const trim = b.references.all.find((i) => i.referenceType === "TRIM");
    expect(trim).toMatchObject({ storageRef: "cl-t", typeLabel: "Material or trim reference" });
  }, 120000);

  test("a correction through the real door keeps the price it did not mention", async () => {
    const w = await world();
    const c = await cast(w.co);
    expect((await askForDevelopment(w, c.salesApprover, FULL_BRIEF)).status).toBe(201);

    const two = await askForDevelopment(w, c.salesApprover, { requiredByDate: "2027-02-01" });
    expect(two.status).toBe(201);
    expect(two.body.request.versionNo).toBe(2);

    const { buyerBrief: b, request } = await briefFor(w, c.owner);
    expect(request.versionNo).toBe(2);
    expect(b.orderContext.requiredByDate).toBe("2027-02-01");
    /* The defect: this used to be gone. */
    expect(b.commercial.targetPrice.amount).toBe(850);
    expect(b.productDirection.fit.value).toBe("Relaxed");

    /* And version 1 is exactly what it stated. */
    const one = await SalesDevelopmentRequest
      .findOne({ companyId: w.co._id, productLineRef: w.productLineRef, versionNo: 1 }).lean();
    expect(one.state).toBe("SUPERSEDED");
    /* Its OWN date, not version 2's — the correction moved the date forward
       and version 1 still says what it said. */
    expect(one.requiredByDate).toBe("2026-10-15");
    expect(one.targetPriceCeiling.amount).toBe(850);
  }, 120000);

  test("an invented choice is refused at the door", async () => {
    const w = await world();
    const c = await cast(w.co);
    const bad = await askForDevelopment(w, c.salesApprover, {
      productDirection: { fit: { choice: "SKINNY_TAPERED" } },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.message).toMatch(/not one of the choices for fit/);
  }, 120000);

  test("the vocabulary the form builds itself from is served by the server", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await sales("/vocabulary", at(w, c.salesViewer));
    expect(res.status).toBe(200);
    /* Both halves: the key that is stored and the words that are shown. */
    expect(res.body.vocabulary.fit).toEqual(
      expect.arrayContaining([{ key: "RELAXED", label: "Relaxed" }]),
    );
    expect(Object.keys(res.body.vocabulary)).toEqual(expect.arrayContaining([
      "market", "season", "intendedUse", "fit", "fabricFamily", "performance",
      "sampleType", "processState", "testing", "certification", "sustainability",
    ]));
    expect(res.body.referenceTypes.TRIM).toBe("Material or trim reference");
  }, 120000);

  test("Merchandising has no door that writes a Sales-owned fact", async () => {
    const w = await world();
    const c = await cast(w.co);
    await askForDevelopment(w, c.salesApprover, FULL_BRIEF);
    const file = await fileFor(w);

    for (const [method, path, payload] of [
      ["PATCH", `/development/${file._id}`, { targetPriceCeiling: { amount: 1, currency: "INR", basis: "PER_PIECE" } }],
      ["PATCH", `/development/${file._id}/brief`, { productDirection: { fit: { choice: "SLIM" } } }],
      ["POST", `/development/${file._id}/brief`, { customerDirection: { market: { choice: "USA" } } }],
      ["PUT", `/development/${file._id}/request`, { requirementSummary: "rewritten" }],
    ]) {
      /* The owner rung, which is the most authority Merchandising has. */
      const res = await call(path, { ...at(w, c.owner), method, body: payload, key: uniq() });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    const { buyerBrief: b } = await briefFor(w, c.owner);
    expect(b.commercial.targetPrice.amount).toBe(850);
    expect(b.productDirection.fit.value).toBe("Relaxed");
  }, 120000);

  test("one company cannot read another's brief", async () => {
    const mine = await world();
    const myCast = await cast(mine.co);
    await askForDevelopment(mine, myCast.salesApprover, FULL_BRIEF);
    const file = await fileFor(mine);

    /* A genuinely separate company, with every grant in it. */
    const theirs = await world();
    const outsider = await actor({ companies: [theirs.co], grants: { merchandiser: "owner" } });
    const res = await call(`/development/${file._id}`, {
      token: outsider.token, company: theirs.co._id,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body || {})).not.toContain("warm ivory");
  }, 120000);

  test("acceptance still works, and a brief-less request still works", async () => {
    const withBrief = await world();
    const c = await cast(withBrief.co);
    await askForDevelopment(withBrief, c.salesApprover, FULL_BRIEF);
    const file = await fileFor(withBrief);
    const accepted = await call(`/development/${file._id}/accept`, {
      ...at(withBrief, c.approver), method: "POST", key: uniq(),
    });
    expect([200, 201]).toContain(accepted.status);
    expect((await briefFor(withBrief, c.owner)).buyerBrief.productDirection.fit.value)
      .toBe("Relaxed");

    /* Every request issued before these fields existed is this case. A second
       company, so its own people — a grant is per company. */
    const bare = await world();
    const bareCast = await cast(bare.co);
    expect((await askForDevelopment(bare, bareCast.salesApprover)).status).toBe(201);
    const out = await briefFor(bare, bareCast.owner);
    expect(out.request.requirementSummary).toMatch(/Navy pique polo/);
    /* ── NOT ₹0 ──────────────────────────────────────────────────────
       An unset ceiling materialises as `amount: null`, and coercing that
       with `Number()` produced a target price of ₹0 per piece — a limit no
       material can be chosen under. */
    expect(out.buyerBrief.commercial.targetPrice).toMatchObject({
      value: null, amount: null, absent: "Sales has not provided a target price",
    });
    expect(out.buyerBrief.missing.length).toBeGreaterThan(0);
  }, 120000);
});
