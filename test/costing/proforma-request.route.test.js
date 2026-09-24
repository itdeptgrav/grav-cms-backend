// test/costing/proforma-request.route.test.js
//
// RAISING A PROFORMA IS A LINE-ADDRESSED COMMAND, NOT A QUANTITY SUBMISSION.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// The browser raised the customer request through the generic
// `POST /customers/:id/create-request` endpoint, sending a stock item, a style
// and A QUANTITY IT HAD COMPOSED ITSELF. That endpoint has no enquiry identity,
// so it could not look up what Sales had confirmed — it stored whatever number
// arrived. A stale tab, a replayed request or a direct call could create a
// draft at 500 against a commercial line confirmed at 750.
//
// The quotation-pricing command would later refuse to price that line. By then
// a wrong document existed, had a reference, and was what somebody opened.
//
// The command now names WHICH LINE and sends no quantity at all. The server
// reads the confirmed quantity under its own company scope, requires the
// costing to be in sync and a floor to exist for that exact quantity, and
// stamps it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const bare = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let rs;
let server;
let base;
let salesBase;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "proforma_request" });

  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  /* The proforma DOCUMENT's own save door, so the tests below can follow one
     line from the enquiry's approved decision through to what the customer
     would read — the two halves used to be tested either side of a boundary
     nobody crossed. */
  app.use("/api/cms/sales", require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/enquiries`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales`;
}, 300000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
}, 300000);

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const CustomerChangeRequest = require("../../models/CMS_Models/Sales/CustomerChangeRequest");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const commercialLine = require("../../services/sales/commercialLine.service");
const proformaRequest = require("../../services/sales/proformaRequest.service");
const costingBrief = require("../../services/sales/costingBrief.service");

let seq = 0;
const actor = { id: String(new mongoose.Types.ObjectId()), name: "A Salesperson" };

async function salesUser(co) {
  const n = ++seq;
  const email = `pf-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "P", lastName: `F${n}`, email, biometricId: `PF${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: `P F${n}`,
  });
  return {
    user: { id: String(emp._id), email, name: `P F${n}`, employeeId: emp.biometricId },
    token: jwt.sign({ id: String(emp._id), email, name: `P F${n}`, role: "employee" },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" }),
  };
}

/**
 * ONE ENQUIRY, THE SAME GARMENT TWICE.
 *
 * Two product rows carrying the same NAME and two different permanent
 * references, each with its own approved style and its own stock item. This is
 * the shape every name-keyed lookup gets wrong.
 */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `PF ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PF-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-PF-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    /* The buyer's opening ask, on both rows. Never what gets invoiced. */
    products: [
      { product: `PF${n} polo`, quantity: 500 },
      { product: `PF${n} polo`, quantity: 500 },
    ],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  const refs = saved.products.map((p) => String(p.productLineRef));

  /* ── A COLOURWAY IS A VARIANT KEY ─────────────────────────────────────
     `SampleStyle` is unique on (journey, productName, variantKey), so two
     styles of one garment on one journey MUST differ by variant key. That is
     the model's own way of saying "the same garment, twice" — and it is
     exactly the shape that breaks a lookup keyed by product name. */
  const styleFor = async (tag) => SampleStyle.create({
    sampleStyleId: `SS-PF-${n}-${tag}`, styleCode: `SC-PF-${n}-${tag}`,
    variantKey: tag,
    productName: `PF${n} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
    techSheet: {
      status: "approved",
      technical: { status: "approved", revision: 1 },
      technicalRevisions: [{
        revision: 1, outcome: "approved",
        submittedAt: new Date("2026-07-01"), submittedBy: { name: "R&D" },
        decidedAt: new Date("2026-07-02"), decidedByName: "Sales",
        snapshot: { materials: [] },
      }],
    },
  });
  const sand = await styleFor("sand");
  const navy = await styleFor("navy");

  const stockFor = async (tag) => StockItem.create({
    name: `PF${n} polo ${tag}`, reference: `SKU-PF-${n}-${tag}`,
    category: "Apparel",
    createdBy: new mongoose.Types.ObjectId(),
    /* ── A STALE CATALOGUE PRICE, ON PURPOSE ──────────────────────────
       ₹599 is what this garment was approved at for 500 pieces, and what the
       retired customer-approval sync wrote across every variant. The line is
       confirmed at 750 and approved at ₹590. Every proforma below must
       invoice ₹590; ₹599 appearing anywhere means the catalogue priced a
       customer document again. */
    baseSalesPrice: 599,
    variants: [{
      attributes: [], sku: `SKU-PF-${n}-${tag}-V1`, cost: 400, salesPrice: 599,
    }],
  });
  const sandStock = await stockFor("sand");
  const navyStock = await stockFor("navy");
  await SampleStyle.updateOne({ _id: sand._id },
    { $set: { "production.stockItemId": sandStock._id, isActive: true } });
  await SampleStyle.updateOne({ _id: navy._id },
    { $set: { "production.stockItemId": navyStock._id, isActive: true } });

  const customer = await Customer.create({
    name: `Buyer ${n}`, email: `buyer${n}@example.com`, phone: "9000000000",
  });

  const me = await salesUser(co);
  global.__ACTOR__ = me.user;

  return {
    co, enquiry, journey, me, customer,
    ctx: { companyId: co._id },
    sand: { ref: refs[0], style: sand, stock: sandStock },
    navy: { ref: refs[1], style: navy, stock: navyStock },
  };
}

const confirm = (w, side, quantity) => commercialLine.confirmQuantity(w.ctx, {
  enquiryId: String(w.enquiry._id),
  productLineRef: w[side].ref,
  sampleStyleId: String(w[side].style._id),
  quantity,
  actor,
});

/**
 * AN APPROVED COMMERCIAL DECISION FOR ONE QUANTITY.
 *
 * ── WRITTEN AS THE ENGINE AND THE REVIEW WRITE IT ───────────────────────────
 * The engine and the review are tested elsewhere; what is under test here is
 * the proforma boundary. This records the same shape a decided version holds:
 *
 *   · a scenario naming its quantity and carrying a floor;
 *   · `commercial.proposedPrices` — the selling price Sales entered, which is
 *     what the review actually decides on;
 *   · `commercial.bridge[].standing` — the engine's own verdict on that price
 *     against that floor, which is the only thing that says whether an
 *     exception was needed;
 *   · `lifecycle.approvedAt/By` — the decision itself.
 *
 * ── WHY ALL FOUR, AND NOT JUST THE FLOOR ────────────────────────────────────
 * An earlier version of this fixture wrote only the floor, and every test here
 * passed while the proforma priced itself from `stockItem.baseSalesPrice`. A
 * fixture that omits the decision cannot notice that nothing consults it.
 *
 * Filed under the product NAME with the STYLE on `context.secondaryId`, which
 * is how two colourways come to have separate costings.
 *
 * @param {number} floorMinor      the floor this quantity was calculated at
 * @param {object} [opts]
 * @param {number} [opts.priceMinor]   the selling price Sales entered; defaults
 *                                     to the floor, the ordinary at-floor case
 * @param {boolean} [opts.approve]     false leaves it calculated, not approved
 * @param {string}  [opts.note]        the approval reason; the exception's record
 * @param {string}  [opts.standing]    override, to model a below-floor decision
 */
async function giveFloor(w, side, quantity, floorMinor, opts = {}) {
  const priceMinor = opts.priceMinor === undefined ? floorMinor : opts.priceMinor;
  const approve = opts.approve !== false;
  const standing = opts.standing
    || (priceMinor === null ? null : (priceMinor >= floorMinor ? "AT_OR_ABOVE_FLOOR" : "BELOW_FLOOR"));
  const enquiry = await Enquiry.findById(w.enquiry._id).lean();
  const productName = enquiry.products.find((p) => String(p.productLineRef) === w[side].ref).product;
  /* A SECOND version on the SAME costing — which is what re-preparing an
     estimate produces, and the only way to have an approved version and a
     newer current one for the same line. */
  const costing = opts.reuseCosting
    ? await Costing.findOne({
      companyId: w.co._id,
      "context.primaryId": w.enquiry._id,
      "context.secondaryId": w[side].style._id,
    })
    : await Costing.create({
    companyId: w.co._id,
    context: {
      type: "ENQUIRY_STYLE",
      primaryId: w.enquiry._id,
      externalKey: productName,
      secondaryId: w[side].style._id,
    },
    contextSnapshot: { label: productName },
    baseCurrency: "INR",
    /* A costing record is always DRAFT; approval lives on the VERSION. */
    status: "DRAFT",
  });
  await CostingVersion.create({
    companyId: w.co._id,
    costingId: costing._id,
    versionNumber: opts.versionNumber || 1,
    status: approve ? "APPROVED" : "DRAFT",
    baseCurrency: "INR",
    /* The engine stamps this; `subjectOf` refuses a version without it. */
    calculation: { engineVersion: 1, calculatedAt: new Date() },
    scenarios: [{
      key: "commercial",
      label: String(quantity),
      quantity: String(quantity),
      quantityUom: "Pieces",
      isPrimary: true,
      unitCostMinor: 50000,
      totalCostMinor: 50000 * quantity,
      floor: {
        floorMarkupPercent: "20",
        calculationMethod: "MARKUP_ON_TRUE_COST",
        trueUnitCostMinor: 50000,
        markupAmountMinor: floorMinor - 50000,
        floorPriceMinor: floorMinor,
      },
    }],
    /* What the review decided ON: the price, and where it stood. Omitted
       entirely where the fixture asks for an unpriced version — a
       `proposedPrices` row with no figure is not a schema-valid record of
       "nobody has decided", it is an invalid one. */
    ...(priceMinor === null ? {} : { commercial: {
      currency: "INR",
      proposedPrices: [{ scenarioKey: "commercial", priceExclTaxMinor: priceMinor, currency: "INR" }],
      bridge: [{
        scenarioKey: "commercial",
        quantity: String(quantity),
        proposedPriceExclTaxMinor: priceMinor,
        proposedRevenueTotalMinor: priceMinor * quantity,
        floorPriceMinor: floorMinor,
        unitCostMinor: 50000,
        totalCostMinor: 50000 * quantity,
        preTaxProfitUnitMinor: priceMinor - 50000,
        preTaxProfitTotalMinor: (priceMinor - 50000) * quantity,
        standing,
      }],
    } }),
    ...(approve ? {
      lifecycle: {
        approvedAt: new Date(),
        approvedByName: "A Reviewer",
        /* A below-floor approval carries the exception's reason; an ordinary
           one need not, and the gate must not demand one of it. */
        ...(opts.note === undefined
          ? (standing === "BELOW_FLOOR" ? { approvalNote: "Strategic account, agreed at the review." } : {})
          : { approvalNote: opts.note }),
      },
    } : {}),
  });

  /* ── AND THE PRICE WHERE SALES PUTS IT ──────────────────────────────────
     The version froze what the review decided on; the ledger row is where
     Sales typed it. Both exist in the real flow — the row is written by
     `PATCH /cost-ledger/line`, which then re-briefs so the version carries
     it — and the gate checks they still agree, so a fixture that wrote only
     one of them would be modelling a state the product cannot reach.

     Keyed by the PAIR, like the route that writes it. A row found by name is
     how one colourway came to be priced from the other's decision. */
  if (opts.ledgerPrice !== null) {
    const price = opts.ledgerPrice === undefined ? priceMinor / 100 : opts.ledgerPrice;
    await Enquiry.updateOne(
      { _id: w.enquiry._id },
      {
        $push: {
          costLedger: {
            productName,
            productLineRef: w[side].ref,
            sampleStyleId: w[side].style._id,
            price,
          },
        },
      },
    );
  }
  return costing;
}

const raise = (w, body, over = {}) => fetch(`${base}/${w.enquiry._id}/proforma-request`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${w.me.token}`,
    "X-Costing-Company": String(w.co._id),
    ...(over.key ? { "Idempotency-Key": over.key } : {}),
  },
  body: JSON.stringify({ customerId: String(w.customer._id), ...body }),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const item = (w, side, extra = {}) => ({
  productLineRef: w[side].ref,
  sampleStyleId: String(w[side].style._id),
  stockItemId: String(w[side].stock._id),
  ...extra,
});

const storedLines = async (id) => {
  const doc = await CustomerRequest.findById(id).lean();
  return (doc?.items || []).map((i) => ({
    productLineRef: i.productLineRef,
    sampleStyleId: String(i.sampleStyleId),
    quantity: i.totalQuantity,
    variantQuantity: i.variants?.[0]?.quantity,
    /* The money as STORED. Read back off the document rather than from the
       response, because what a customer is invoiced is what was saved. */
    unitPrice: i.variants?.[0]?.quantity
      ? (i.variants[0].estimatedPrice || 0) / i.variants[0].quantity
      : null,
    estimatedPrice: i.variants?.[0]?.estimatedPrice,
    totalEstimatedPrice: i.totalEstimatedPrice,
    decision: i.commercialDecision || null,
  }));
};

/* ═══ 1 · THE QUANTITY IS THE SERVER'S ════════════════════════════════════ */

describe("the confirmed quantity is the only one a proforma may carry", () => {
  test("a forged 500 against a confirmed 750 stores only 750", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);

    /* The number a stale tab would still be showing, sent as hard as a
       client can send it. */
    const r = await raise(w, {
      items: [item(w, "sand", { quantity: 500, totalQuantity: 500, variants: [{ quantity: 500 }] })],
    });

    expect(r.status).toBe(201);
    const lines = await storedLines(r.body._id);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(750);
    expect(lines[0].variantQuantity).toBe(750);
    /* ── AND NOTHING OF THE 500 SURVIVED AS A QUANTITY ────────────────
       Asserted on the quantity-bearing fields rather than as a substring of
       the whole line: ₹590 × 750 is 442500, which CONTAINS "500", so the
       substring form passed only while the line carried no money. Naming the
       fields is what makes this hold now that it does. */
    expect(lines[0].quantity).not.toBe(500);
    expect(lines[0].variantQuantity).not.toBe(500);
    expect(lines[0].decision.quantity).toBe(750);
  });

  test("sending no quantity at all is the ordinary case, and works", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(201);
    expect((await storedLines(r.body._id))[0].quantity).toBe(750);
  });
});

describe("customer-requested changes are a purchase-invoice hold", () => {
  test("an open routed change blocks the entire enquiry until it is resolved", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);
    await CustomerChangeRequest.create({
      companyId: w.co._id,
      journeyId: w.journey._id,
      enquiryId: w.enquiry._id,
      productLineRef: w.navy.ref,
      productName: "The other colourway",
      sampleStyleId: w.navy.style._id,
      categories: ["SAMPLE_ROUND"],
      customerFeedback: "Please revise it.",
      suggestedDestination: "SAMPLE_ROUND",
      destination: "SAMPLE_ROUND",
      owner: "r&d",
      status: "OPEN",
    });

    const blocked = await raise(w, { items: [item(w, "sand")] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("PROFORMA_CUSTOMER_CHANGE_OPEN");
    expect(blocked.body.changes[0].owner).toBe("r&d");
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(0);

    await CustomerChangeRequest.updateMany({}, { $set: { status: "RESOLVED" } });
    const allowed = await raise(w, { items: [item(w, "sand")] });
    expect(allowed.status).toBe(201);
  });
});

/* ═══ 1B · THE PRICE IS THE APPROVED DECISION, NEVER THE CATALOGUE ════════ */

describe("the price a proforma carries", () => {
  test("750 at an approved ₹590 stores ₹590, never the catalogue's ₹599", async () => {
    /* ── THE ACCEPTANCE CASE ──────────────────────────────────────────────
       The stock item holds ₹599 — what this garment was approved at for 500
       pieces, and what the retired customer-approval sync fanned across every
       variant. The line is confirmed at 750 and approved at ₹590.

       ₹599 is asserted against BY NAME: it is a plausible price that would
       make every figure on the document internally consistent and wrong, and
       only this comparison catches a regression to the catalogue. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { priceMinor: 59000 });

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(201);

    const [line] = await storedLines(r.body._id);
    expect(line.quantity).toBe(750);
    expect(line.unitPrice).toBe(590);
    expect(line.unitPrice).not.toBe(599);
    /* 750 × ₹590, computed from the approved figure. */
    expect(line.estimatedPrice).toBe(442500);
    expect(line.totalEstimatedPrice).toBe(442500);
    /* And the catalogue's figure is nowhere on the stored line. */
    expect(JSON.stringify(line)).not.toContain("599");
  });

  test("the stamped decision names the version, the floor and the approver", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { priceMinor: 61000 });

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(201);
    const { decision } = (await storedLines(r.body._id))[0];
    expect(decision).toBeTruthy();
    expect(decision.quantity).toBe(750);
    expect(decision.unitPriceMinor).toBe(61000);
    expect(decision.floorPriceMinor).toBe(59000);
    expect(decision.standing).toBe("AT_OR_ABOVE_FLOOR");
    expect(decision.wasBelowFloorException).toBe(false);
    expect(decision.approvedByName).toBe("A Reviewer");
    expect(decision.costingVersionNumber).toBe(1);
  });

  test("a forged unit price in the body is ignored, not stored", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { priceMinor: 59000 });

    const r = await raise(w, {
      items: [item(w, "sand", {
        unitPrice: 1, basePrice: 1, estimatedPrice: 750,
        totalEstimatedPrice: 750,
        variants: [{ quantity: 750, estimatedPrice: 750 }],
        commercialDecision: { unitPriceMinor: 100, floorPriceMinor: 1 },
      })],
    });
    expect(r.status).toBe(201);
    const [line] = await storedLines(r.body._id);
    expect(line.unitPrice).toBe(590);
    expect(line.estimatedPrice).toBe(442500);
    /* The forged provenance did not land either. */
    expect(line.decision.unitPriceMinor).toBe(59000);
    expect(line.decision.floorPriceMinor).toBe(59000);
  });

  test("an at-or-above-floor approved price succeeds", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { priceMinor: 59000 });
    expect((await raise(w, { items: [item(w, "sand")] })).status).toBe(201);
  });

  test("a below-floor price succeeds ONLY with a completed exception", async () => {
    /* ── THE FLOOR IS A RULE, NOT ADVICE ──────────────────────────────────
       Ordinary approval refuses a below-floor standing, so an approved
       version carrying one went through the executive door — which requires a
       reason. The reason IS the record of the exception, so its absence means
       the stamp cannot be accounted for. */
    const without = await world();
    await confirm(without, "sand", 750);
    await giveFloor(without, "sand", 750, 59000, { priceMinor: 55000, note: "" });
    const refused = await raise(without, { items: [item(without, "sand")] });
    /* 409, not 422: the request is well-formed and the commercial state
       disagrees with it — the same distinction this door already drew. */
    expect(refused.status).toBe(409);
    expect(refused.body.lines[0].reason).toBe("EXCEPTION_REQUIRED");

    const with_ = await world();
    await confirm(with_, "sand", 750);
    await giveFloor(with_, "sand", 750, 59000, {
      priceMinor: 55000, note: "Strategic account; approved below floor at the review.",
    });
    const ok = await raise(with_, { items: [item(with_, "sand")] });
    expect(ok.status).toBe(201);
    const [line] = await storedLines(ok.body._id);
    expect(line.unitPrice).toBe(550);
    expect(line.decision.wasBelowFloorException).toBe(true);
    expect(line.decision.decisionReason).toMatch(/below floor/i);
  });

  test("a DRAFT costing carrying a floor cannot authorise a proforma", async () => {
    /* ── AN ESTIMATE IS NOT A DECISION ────────────────────────────────────
       The readiness question a screen asks ("is there a floor for this
       quantity?") can be answered yes by a calculated draft. Issuing a
       customer document cannot. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { approve: false });
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("COSTING_NOT_APPROVED");
  });

  test("an approved costing with no commercial decision refuses", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    /* Approved, floored — and never priced, so nothing was reviewed. */
    await giveFloor(w, "sand", 750, 59000, { priceMinor: null, ledgerPrice: null });
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(["SELLING_PRICE_NOT_SET", "REVIEW_NOT_REVIEWABLE"])
      .toContain(r.body.lines[0].reason);
  });

  test("an approval for a DIFFERENT selling price refuses", async () => {
    /* Sales typed a new price after the review. The approval covers the old
       one, so it does not cover what would be invoiced. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000, { priceMinor: 59000, ledgerPrice: 640 });
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("SELLING_PRICE_CHANGED");
  });

  test("an approval for a DIFFERENT quantity refuses", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    /* Approved, priced and decided — for 500. */
    await giveFloor(w, "sand", 500, 59900, { priceMinor: 59900 });
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(["COSTING_NOT_IN_SYNC", "FLOOR_NOT_AVAILABLE", "APPROVED_FOR_ANOTHER_QUANTITY"])
      .toContain(r.body.lines[0].reason);
  });
});

/* ═══ 2 · TWO COLOURWAYS ARE TWO LINES ════════════════════════════════════ */

describe("same-name rows keep their own quantity and style", () => {
  test("two lines are created, each with its own confirmed quantity", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await confirm(w, "navy", 400);
    await giveFloor(w, "sand", 750, 59000);
    await giveFloor(w, "navy", 400, 61000);

    const r = await raise(w, { items: [item(w, "sand"), item(w, "navy")] });
    expect(r.status).toBe(201);

    const lines = await storedLines(r.body._id);
    expect(lines).toHaveLength(2);
    const bySand = lines.find((l) => l.productLineRef === w.sand.ref);
    const byNavy = lines.find((l) => l.productLineRef === w.navy.ref);
    expect(bySand.quantity).toBe(750);
    expect(byNavy.quantity).toBe(400);
    /* Two styles, not one applied twice. */
    expect(bySand.sampleStyleId).toBe(String(w.sand.style._id));
    expect(byNavy.sampleStyleId).toBe(String(w.navy.style._id));
  });

  test("confirming the second colourway does not close the first's costing", async () => {
    /* ── THE BRIEF SUPERSESSION THAT USED TO BITE ─────────────────────
       Confirming a brief superseded every other confirmed brief for the
       same PRODUCT NAME. With two colourways that meant confirming Navy
       silently closed Sand's, so Sand went out of sync with a costing
       nobody had touched — and a proforma for both then refused on it.

       Where the enquiry has two rows for one product, both are legitimately
       in play and neither supersedes the other. Where it has one, a second
       style still means Sales MOVED the quotation, and the old brief is
       still closed — see `sales-costing-brief`. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);
    await confirm(w, "navy", 400);
    await giveFloor(w, "navy", 400, 61000);

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(201);
    expect((await storedLines(r.body._id))[0].quantity).toBe(750);
  });

  test("a swapped reference and style is refused, not resolved", async () => {
    /* Both halves are real; the PAIR is not. Matching on either alone would
       hand this line the other colourway's quantity. */
    const w = await world();
    await confirm(w, "sand", 750);
    await confirm(w, "navy", 400);
    await giveFloor(w, "sand", 750, 59000);

    const r = await raise(w, {
      items: [{
        productLineRef: w.sand.ref,
        sampleStyleId: String(w.navy.style._id),
        stockItemId: String(w.sand.stock._id),
      }],
    });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PROFORMA_COMMERCIAL_STATE_CONFLICT");
    expect(r.body.lines[0].reason).toBe("LINE_NOT_FOUND");
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(0);
  });

  test("half a key is refused rather than completed from the other half", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);

    for (const half of [
      { productLineRef: w.sand.ref, stockItemId: String(w.sand.stock._id) },
      { sampleStyleId: String(w.sand.style._id), stockItemId: String(w.sand.stock._id) },
    ]) {
      const r = await raise(w, { items: [half] });
      expect(r.status).toBe(409);
      expect(r.body.lines[0].reason).toBe("LINE_KEY_REQUIRED");
    }
  });
});

/* ═══ 3 · EVERY UNREADY STATE REFUSES ═════════════════════════════════════ */

describe("a line that is not ready cannot reach a proforma", () => {
  test("no commercial line at all", async () => {
    const w = await world();
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("LINE_NOT_FOUND");
  });

  test("a costing that has not caught up with the confirmed quantity", async () => {
    const w = await world();
    await confirm(w, "sand", 500);
    jest.spyOn(costingBrief, "confirmBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure after the commercial line was written");
    });
    await confirm(w, "sand", 750);
    jest.restoreAllMocks();
    await giveFloor(w, "sand", 750, 59000);

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("COSTING_NOT_IN_SYNC");
  });

  test("a floor calculated for a DIFFERENT quantity is not a floor for this one", async () => {
    /* ── THE GAP THE OLD GATE HAD ─────────────────────────────────────
       The selling-price gate asked only whether the approved version
       carried ANY floor, so a floor for 500 satisfied a line confirmed at
       750. The scenario's own quantity is compared now. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 500, 59900);

    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("FLOOR_NOT_AVAILABLE");
  });

  test("no floor at all", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    const r = await raise(w, { items: [item(w, "sand")] });
    expect(r.status).toBe(409);
    expect(r.body.lines[0].reason).toBe("FLOOR_NOT_AVAILABLE");
  });

  test("a style that is not this enquiry's, and one not linked to the stock item", async () => {
    const w = await world();
    const other = await world();
    global.__ACTOR__ = w.me.user;
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);

    const foreign = await raise(w, {
      items: [{
        productLineRef: w.sand.ref,
        sampleStyleId: String(other.sand.style._id),
        stockItemId: String(w.sand.stock._id),
      }],
    });
    expect(foreign.status).toBe(409);

    const mismatched = await raise(w, {
      items: [item(w, "sand", { stockItemId: String(w.navy.stock._id) })],
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.lines[0].reason).toBe("STYLE_STOCK_MISMATCH");
  });

  test("one bad line refuses the whole request — no half proforma", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);
    /* Navy has nothing confirmed. */
    const r = await raise(w, { items: [item(w, "sand"), item(w, "navy")] });

    expect(r.status).toBe(409);
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0].reason).toBe("LINE_NOT_FOUND");
    /* A document missing the line somebody meant to invoice looks complete
       and is not. Nothing was written. */
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(0);
  });
});

/* ═══ 4 · RETRIES, AND OTHER COMPANIES ════════════════════════════════════ */

describe("the command is safe to repeat and scoped to one company", () => {
  test("an exact retry replays instead of raising a second proforma", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 59000);

    const key = `pf-retry-${Date.now()}`;
    const first = await raise(w, { items: [item(w, "sand")] }, { key });
    const second = await raise(w, { items: [item(w, "sand")] }, { key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(String(second.body._id)).toBe(String(first.body._id));
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });

  test("two presses with DIFFERENT keys make ONE document — the guard is the server's", async () => {
    /* ── WHAT THE LIVE RUN EXPOSED ────────────────────────────────────
       A double-click on Create proforma invoice produced two customer
       requests. Each press minted its own idempotency key, so the server saw
       two distinct commands and honoured both.

       The key was never the right identity for this. It answers "is this the
       same press again?", and two presses, two tabs, two people and a retried
       proxy are all different presses in the same commercial state. What may
       not exist twice is a proforma for ONE confirmed quantity at ONE approved
       price — so that is what the server claims, and the second insert loses
       to a unique index rather than to a check that happened to run first.

       The browser guard stays, and is now what it should always have been:
       an interaction nicety, not the correctness boundary. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR" });

    const a = await raise(w, { items: [item(w, "sand")] }, { key: "press-one" });
    const b = await raise(w, { items: [item(w, "sand")] }, { key: "press-two" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(String(b.body._id)).toBe(String(a.body._id));
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });

  test("another company's enquiry is not found, never forbidden", async () => {
    const w = await world();
    const stranger = await world();
    global.__ACTOR__ = w.me.user;

    const r = await fetch(`${base}/${stranger.enquiry._id}/proforma-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${w.me.token}`,
        "X-Costing-Company": String(w.co._id),
      },
      body: JSON.stringify({ customerId: String(w.customer._id), items: [item(stranger, "sand")] }),
    }).then(async (x) => ({ status: x.status, body: JSON.parse((await x.text()) || "null") }));

    /* The same answer an enquiry that does not exist gets. A refusal that
       varies with the answer is a way to enumerate other companies' work. */
    const invented = await fetch(`${base}/${new mongoose.Types.ObjectId()}/proforma-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${w.me.token}`,
        "X-Costing-Company": String(w.co._id),
      },
      body: JSON.stringify({ customerId: String(w.customer._id), items: [item(w, "sand")] }),
    }).then(async (x) => ({ status: x.status, body: JSON.parse((await x.text()) || "null") }));

    expect(r.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(r.body.message).toBe(invented.body.message);
  });
});

/* ═══ 5 · THE OTHER DOOR IS UNCHANGED, AND STILL CHECKS ═══════════════════ */

describe("defence in depth", () => {
  test("the generic customer-request endpoint is untouched", () => {
    /* Historical callers — the customer portal's own slider among them —
       still post to it. Narrowing the proforma path must not narrow theirs. */
    const generic = bare(fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/salesCustomers.js"), "utf8",
    ));
    expect(generic).toMatch(/router\.post\("\/:id\/create-request"/);
    /* And it still takes its quantity from the request, which is correct for
       a caller that has no enquiry and no commercial line. */
    expect(generic).toMatch(/Number\(variant\.quantity\)/);
  });

  test("quotation pricing still verifies the quantity independently", () => {
    /* Two commands, two checks. This one decides what the document may say;
       that one decides what may be charged, and re-reads the line rather
       than trusting that this one got it right. */
    const pricing = bare(fs.readFileSync(
      path.join(__dirname, "../../services/centralCosting/quotationPricing.service.js"), "utf8",
    ));
    expect(pricing).toMatch(/resolveCommercialLine\(ctx, intent\)/);
    expect(pricing).toMatch(/quantity: commercial\.quantity/);
  });

  test("the proforma service reads no client quantity at all", () => {
    /* Not "compares and refuses" — never reads. There is nothing to compare
       against, because the only quantity a line may carry is the confirmed
       one, so a submitted figure is noise rather than a second opinion. */
    const svc = bare(fs.readFileSync(
      path.join(__dirname, "../../services/sales/proformaRequest.service.js"), "utf8",
    ));
    expect(svc).not.toMatch(/item\.quantity/);
    expect(svc).not.toMatch(/item\.totalQuantity/);
    expect(svc).toMatch(/quantity: ready\.quantity/);
  });
});

/* ═══ 7 · THE OTHER PROFORMA DOOR IS A DIFFERENT DOCUMENT ════════════════ */

describe("the Accountant proforma is not this proforma", () => {
  /* ── WHY THIS IS ASSERTED AND NOT ASSUMED ───────────────────────────────
     `/api/accountant/proforma-invoices` takes a quantity and a rate from its
     request body and consults no commercial line, no costing and no floor. If
     it could raise the Sales customer proforma for one of these enquiry lines,
     every gate in this file would have a second door beside it.

     It cannot: it is a different record, in a different collection, behind a
     different auth system, with no link to an enquiry, a style or a commercial
     line. That separation is what makes its freedom acceptable, so it is
     pinned rather than trusted. */

  test("it writes its own collection and never CustomerRequest", async () => {
    const fs = require("fs");
    const route = fs.readFileSync("routes/Accountant_Routes/Acc_proformaInvoices.js", "utf8");
    /* No access to the record this suite's proforma is stored as. */
    expect(route).not.toMatch(/CustomerRequest/);
    /* And no way to name one of these lines even if it wanted to. */
    for (const key of ["productLineRef", "sampleStyleId", "enquiryId", "commercialLines"]) {
      expect(route.includes(key)).toBe(false);
    }
  });

  test("its model is a separate collection with no enquiry linkage", async () => {
    const fs = require("fs");
    const model = fs.readFileSync("models/Accountant_model/Acc_ProformaInvoice.js", "utf8");
    expect(model).toMatch(/collection: "acc_proforma_invoices"/);
    for (const key of ["productLineRef", "sampleStyleId", "enquiryId"]) {
      expect(model.includes(key)).toBe(false);
    }
  });

  test("and the Sales proforma door is the only writer of these lines", async () => {
    /* Every CustomerRequest line carrying a commercial decision came through
       `proformaRequest.service`. Asserted by searching the tree for any other
       writer of the stamp.

       READING IT IS NOT WRITING IT. The proforma document prices its lines
       from this block and the save door refuses to overwrite it, so both of
       those files name it — and must, because the alternative is each of them
       keeping its own copy of the approved price. What none of them may do is
       ASSIGN one, so that is what this looks for rather than the mere mention
       it used to reject. */
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    let hits = "";
    try {
      hits = execFileSync("grep", ["-rl", "commercialDecision", "routes", "services"], { encoding: "utf8" }).trim();
    } catch { hits = ""; }
    const files = hits.split("\n").filter(Boolean);
    expect(files).toContain("services/sales/proformaRequest.service.js");

    const writers = files.filter((f) => {
      /* A test's own fixture is not a writer of production code — the rule
         here is about which SERVICE may assign the block. Without this the
         scan counts any suite that builds one in a fixture. */
      if (/\.test\.js$/.test(f)) return false;
      const text = bare(fs.readFileSync(f, "utf8"));
      /* `commercialDecision:` (an object literal being built) or
         `commercialDecision =` (an assignment). `==`/`===` are comparisons. */
      return /commercialDecision\s*:/.test(text) || /commercialDecision\s*=[^=]/.test(text);
    });
    expect(writers).toEqual(["services/sales/proformaRequest.service.js"]);
  });
});


/* ═══ 6 · THE READINESS PROJECTION THE SCREEN READS ═══════════════════════ */

describe("the proforma-readiness read", () => {
  /**
   * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
   * The screen worked readiness out from four separate facts, one of which was
   * the review's stored `reviewState`. That state is the outcome of the LAST
   * review and keeps saying APPROVED after the price it approved has been typed
   * over — so the page showed "Commercial review — Approved" and "Everything it
   * needs is in place" above a command that refused.
   *
   * This read asks the command's own authority, so the summary and the gate are
   * the same sentence.
   */
  const read = (w, over = {}) => fetch(`${base}/${over.enquiryId || w.enquiry._id}/proforma-readiness`, {
    headers: {
      Authorization: `Bearer ${(over.me || w.me).token}`,
      "X-Costing-Company": String((over.co || w.co)._id),
    },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  /** Put a priced, approved line in place and then move the price. */
  /**
   * A confirmed, costed line with a price on the SALES LEDGER.
   *
   * By default the approved version carries NO proposed price, which is the
   * ordinary "Sales has typed a figure, nobody has reviewed it" state. Pass
   * `priceMinor` to make the version's own approved price something specific —
   * that is how a stale approval is built.
   */
  async function pricedAt(w, side, quantity, floorMinor, priceMajor, opts = {}) {
    await confirm(w, side, quantity);
    /* `priceMinor: null` leaves the VERSION with no proposed price — nobody
       has reviewed anything — while `ledgerPrice` is the figure Sales has
       typed. One ledger row per line: `giveFloor` writes it, so pushing a
       second here would leave two rows for one key and the lookup would
       answer with whichever came first. */
    await giveFloor(w, side, quantity, floorMinor, {
      priceMinor: null, ledgerPrice: priceMajor, ...opts,
    });
  }

  test("a line with nothing confirmed is blocked, and says so", async () => {
    const w = await world();
    const r = await read(w);
    expect(r.status).toBe(200);
    /* No confirmed line means no entry at all — there is nothing to be
       ready for, and inventing a row would be inventing a line. */
    expect(r.body.lines).toHaveLength(0);
  });

  test("a confirmed quantity whose costing has no floor is blocked by name", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    const r = await read(w);

    expect(r.body.lines).toHaveLength(1);
    const v = r.body.lines[0];
    expect(v.readiness).toBe("BLOCKED");
    expect(v.blocker.code).toBe("FLOOR_NOT_AVAILABLE");
    /* The quantity is a settled fact even while the costing is not. It must
       never read as unconfirmed. */
    expect(v.confirmedQuantity).toBe(750);
  });

  test("a price set but never reviewed needs ORDINARY approval when at or above the floor", async () => {
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 160);

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("BLOCKED");
    expect(v.floorPriceMinor).toBe(15200);
    expect(v.sellingPriceMinor).toBe(16000);
    expect(v.requiredApproval).toBe("COMMERCIAL");
  });

  test("a price BELOW the floor needs the executive exception", async () => {
    /* ── THE LIVE CASE ────────────────────────────────────────────────
       750 confirmed, a ₹152 floor, ₹120 typed. ₹32 under, and the browser
       is never the one that works that out. */
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 120);

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("BLOCKED");
    expect(v.confirmedQuantity).toBe(750);
    expect(v.floorPriceMinor).toBe(15200);
    expect(v.sellingPriceMinor).toBe(12000);
    expect(v.requiredApproval).toBe("EXECUTIVE");
  });

  test("an APPROVED review whose price has since changed never reads as approved", async () => {
    /* ── THE STALE APPROVAL ───────────────────────────────────────────
       The version is approved, for ₹590. Sales then types ₹120. The review
       record still says APPROVED — and this read must not. */
    const w = await world();
    await confirm(w, "sand", 750);
    /* Approved for ₹590 — the price that WAS reviewed. */
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 59000 });
    const e = await Enquiry.findById(w.enquiry._id);
    e.costLedger = [{
      productName: e.products[0].product, productLineRef: w.sand.ref,
      sampleStyleId: String(w.sand.style._id), price: 120,
    }];
    await e.save();

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("BLOCKED");
    expect(v.blocker.code).toBe("SELLING_PRICE_CHANGED");
    /* And the approval the NEW price would need, which is the only thing
       left to do about it. */
    expect(v.requiredApproval).toBe("EXECUTIVE");
    expect(JSON.stringify(v)).not.toContain("APPROVED");
  });

  test("a refreshed estimate reads as UNDECIDED, not as out of date", async () => {
    /* ── THE DEFECT THE LIVE RUN FOUND ────────────────────────────────
       A price typed after approval reports SELLING_PRICE_CHANGED, whose
       action is "refresh the estimate". Once that refresh has happened the
       latest version carries the new price and is current — but the
       comparison is against the APPROVED version, which is still the old
       one, so the reason never moved and the screen kept offering a refresh
       that changed nothing.

       Issuance still refuses; what changes is the reason and therefore the
       next action, which is now the decision. */
    const w = await world();
    await confirm(w, "sand", 750);
    /* The approved version priced ₹590. */
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 59000, ledgerPrice: 120 });
    /* And a newer, current one prices the ₹120 Sales actually typed. */
    await giveFloor(w, "sand", 750, 15200, {
      priceMinor: 12000, approve: false, versionNumber: 2, ledgerPrice: null, reuseCosting: true,
    });

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("BLOCKED");
    expect(v.blocker.code).toBe("REVIEW_INCOMPLETE");
    expect(v.sellingPriceMinor).toBe(12000);
    expect(v.requiredApproval).toBe("EXECUTIVE");
  });

  test("a price cleared under the floor is reported as an exception", async () => {
    /* ── THE ONE FACT THAT MAKES THE LINE UNUSUAL ─────────────────────
       "Approved" alone would hide that this price is below the company's
       floor and was cleared by an executive. The server says which door the
       approval came through; the screen never works it out from figures. */
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, {
      priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR",
    });

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("READY");
    expect(v.approvedByException).toBe(true);
    expect(v.sellingPriceMinor).toBe(12000);
    expect(v.floorPriceMinor).toBe(15200);
  });

  test("an ordinary at-or-above approval is NOT reported as an exception", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 16000, ledgerPrice: 160 });

    const v = (await read(w)).body.lines[0];
    expect(v.readiness).toBe("READY");
    expect(v.approvedByException).toBe(false);
  });

  test("the read and the command agree, always", async () => {
    /* ── THE WHOLE POINT ──────────────────────────────────────────────
       Whatever the read says, the command does. Asserted by doing both. */
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 120);

    const v = (await read(w)).body.lines[0];
    const created = await raise(w, { items: [item(w, "sand")] }, { key: `agree-${Date.now()}` });

    expect(v.readiness).toBe("BLOCKED");
    expect(created.status).toBe(409);
    expect(created.body.lines[0].reason).toBe(v.blocker.code);
  });

  test("two colourways get two verdicts, neither answering for the other", async () => {
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 120);
    await confirm(w, "navy", 400);

    const lines = (await read(w)).body.lines;
    expect(lines).toHaveLength(2);
    const sand = lines.find((l) => l.productLineRef === w.sand.ref);
    const navy = lines.find((l) => l.productLineRef === w.navy.ref);
    expect(sand.confirmedQuantity).toBe(750);
    expect(navy.confirmedQuantity).toBe(400);
    expect(sand.requiredApproval).toBe("EXECUTIVE");
    /* Navy has no floor yet, so there is no price to judge. */
    expect(navy.blocker.code).toBe("FLOOR_NOT_AVAILABLE");
    expect(navy.requiredApproval).toBeNull();
  });

  test("nothing confidential travels", async () => {
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 120);
    const body = JSON.stringify((await read(w)).body);

    /* The floor and the selling price are commercial answers Sales acts on.
       Everything the costing was built from is not. */
    for (const secret of [
      "unitCostMinor", "totalCostMinor", "trueUnitCost", "markup", "supplier",
      "fingerprint", "costingVersionId", "costingId", "scenarioKey",
      "minimumPrice", "targetPrice", "preferredPrice",
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test("controls come from the server's permitted, and default to none", async () => {
    const w = await world();
    await pricedAt(w, "sand", 750, 15200, 120);
    const v = (await read(w)).body.lines[0];
    expect(Object.keys(v.permitted).sort())
      .toEqual(["approve", "approveException", "return", "submit"]);
    for (const k of Object.keys(v.permitted)) expect(typeof v.permitted[k]).toBe("boolean");
  });

  test("another company's enquiry is not found, never forbidden", async () => {
    const w = await world();
    const stranger = await world();
    global.__ACTOR__ = w.me.user;

    const foreign = await read(w, { enquiryId: stranger.enquiry._id });
    const invented = await read(w, { enquiryId: new mongoose.Types.ObjectId() });
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(foreign.body.message).toBe(invented.body.message);
  });
});

/* ═══ 8 · ONE CURRENT PROFORMA PER COMMERCIAL STATE ═══════════════════════ */

describe("two callers in one commercial state get one document", () => {
  /**
   * ── WHY THESE RUN AT THE COMMAND, NOT THROUGH THE ROUTE ───────────────────
   * The route's auth mock reads ONE global actor, so two genuinely
   * simultaneous HTTP calls cannot carry two different people through it. The
   * boundary under test is the command's, and calling it directly is the only
   * way to start two of them in the same tick — which is exactly the state a
   * double-click, two tabs and a retried proxy produce.
   *
   * `Promise.all`, never awaited in turn: the whole point is that both calls
   * read "nothing raised yet" before either of them inserts. That is the
   * window a check-then-insert leaves open, and the window the unique index
   * closes.
   */
  const ready = async (w, side = "sand") => {
    await confirm(w, side, 750);
    await giveFloor(w, side, 750, 15200, { priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR" });
  };
  const call = (w, over = {}) => proformaRequest.createForEnquiry(
    over.ctx || w.ctx,
    String(w.enquiry._id),
    {
      customerId: String(w.customer._id),
      items: over.items || [item(w, "sand")],
      actionKey: over.actionKey || "",
      actor: over.actor || actor,
      ...(over.supersedes ? { supersedes: over.supersedes } : {}),
    },
  );
  const countFor = (w) => CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id });

  test("two simultaneous calls with DIFFERENT idempotency keys create one request", async () => {
    const w = await world();
    await ready(w);

    const [a, b] = await Promise.all([
      call(w, { actionKey: "tab-a-press" }),
      call(w, { actionKey: "tab-b-press" }),
    ]);

    expect(String(a._id)).toBe(String(b._id));
    expect(a.requestId).toBe(b.requestId);
    /* One of them created it and the other was answered with it — which one
       won is a race and is deliberately not asserted. What is asserted is
       that exactly one of them created anything. */
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await countFor(w)).toBe(1);
  });

  test("two simultaneous calls from DIFFERENT actors create one request", async () => {
    const w = await world();
    await ready(w);
    const other = await salesUser(w.co);

    const [a, b] = await Promise.all([
      call(w, { actionKey: "mine", actor, ctx: { companyId: w.co._id, actorId: actor.id } }),
      call(w, {
        actionKey: "theirs",
        actor: { id: other.user.id, name: other.user.name },
        ctx: { companyId: w.co._id, actorId: other.user.id },
      }),
    ]);

    expect(String(a._id)).toBe(String(b._id));
    expect(a.requestId).toBe(b.requestId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await countFor(w)).toBe(1);
  });

  test("a retry after a lost response replays on the same key", async () => {
    const w = await world();
    await ready(w);

    const first = await call(w, { actionKey: "lost-response" });
    const retry = await call(w, { actionKey: "lost-response" });

    expect(retry.replayed).toBe(true);
    expect(retry.reason).toBe("SAME_ACTION_KEY");
    expect(String(retry._id)).toBe(String(first._id));
    expect(await countFor(w)).toBe(1);
  });

  test("a press after a page reload — a brand new key — opens what exists", async () => {
    /* A reload throws away the in-flight ref AND the key the first press
       minted. Both of the old protections are gone; the claim is not. */
    const w = await world();
    await ready(w);

    const first = await call(w, { actionKey: "before-reload" });
    const afterReload = await call(w, { actionKey: "after-reload-fresh-key" });

    expect(afterReload.replayed).toBe(true);
    expect(afterReload.reason).toBe("SAME_COMMERCIAL_STATE");
    expect(String(afterReload._id)).toBe(String(first._id));
    expect(afterReload.requestId).toBe(first.requestId);
    expect(await countFor(w)).toBe(1);
  });

  test("Open proforma invoice reuses the existing request rather than raising one", async () => {
    /* What the screen's primary action does once a proforma exists: the same
       command, which answers with the same durable document. */
    const w = await world();
    await ready(w);
    const first = await call(w, { actionKey: "create" });

    const opened = await raise(w, { items: [item(w, "sand")] }, { key: "open-press" });
    expect(opened.status).toBe(200);
    expect(opened.body.replayed).toBe(true);
    expect(opened.body.requestId).toBe(first.requestId);
    expect(await countFor(w)).toBe(1);
  });

  test("two colourways go on ONE request, and a second call replays it", async () => {
    const w = await world();
    await ready(w, "sand");
    await confirm(w, "navy", 400);
    await giveFloor(w, "navy", 400, 15200, {
      priceMinor: 20000, ledgerPrice: 200, approve: true, reuseCosting: false,
    });

    const both = [item(w, "sand"), item(w, "navy")];
    const first = await call(w, { actionKey: "both-1", items: both });
    const again = await call(w, { actionKey: "both-2", items: both });

    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(String(again._id)).toBe(String(first._id));
    expect(await countFor(w)).toBe(1);

    const lines = await storedLines(first._id);
    expect(lines.map((l) => l.productLineRef).sort()).toEqual([w.sand.ref, w.navy.ref].sort());
    /* And the two lines kept their own quantities — the claim collapses two
       CALLS, never two lines. */
    expect(lines.find((l) => l.productLineRef === w.sand.ref).quantity).toBe(750);
    expect(lines.find((l) => l.productLineRef === w.navy.ref).quantity).toBe(400);

    /* Order is not part of the state: the same two lines the other way round
       is the same claim. */
    const reversed = await call(w, { actionKey: "both-3", items: [item(w, "navy"), item(w, "sand")] });
    expect(String(reversed._id)).toBe(String(first._id));
    expect(await countFor(w)).toBe(1);
  });

  test("another company's enquiry is not found, and creates nothing", async () => {
    const w = await world();
    const stranger = await world();
    await ready(stranger);

    await expect(proformaRequest.createForEnquiry(
      w.ctx,
      String(stranger.enquiry._id),
      { customerId: String(w.customer._id), items: [item(stranger, "sand")], actor },
    )).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await countFor(stranger)).toBe(0);
  });

  test("the same commercial state in two companies is two claims, not a collision", async () => {
    /* A CustomerRequest carries no company of its own, so the company is
       inside the claim. Two companies raising an identical-looking proforma
       must both succeed. */
    const a = await world();
    const b = await world();
    await ready(a);
    await ready(b);

    const ra = await call(a, { actionKey: "co-a" });
    const rb = await call(b, { actionKey: "co-b" });

    expect(String(ra._id)).not.toBe(String(rb._id));
    expect(await countFor(a)).toBe(1);
    expect(await countFor(b)).toBe(1);
  });
});

describe("a moved commercial state needs a deliberate successor", () => {
  const ready = async (w) => {
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR" });
  };
  const call = (w, over = {}) => proformaRequest.createForEnquiry(w.ctx, String(w.enquiry._id), {
    customerId: String(w.customer._id),
    items: [item(w, "sand")],
    actionKey: over.actionKey || "",
    actor,
    ...(over.supersedes ? { supersedes: over.supersedes } : {}),
  });

  /**
   * A GENUINELY DIFFERENT COMMERCIAL STATE, reached the way the workflow
   * reaches one: Sales re-prices the line, and a reviewer approves a NEW
   * version carrying that figure. The confirmed quantity is untouched, so
   * what moved is the price and the version that approved it — both of which
   * are part of the claim, which is the whole point.
   */
  const moveTo = async (w, priceMinor, ledgerPrice) => {
    /* The ledger holds ONE row per line — the route that writes it replaces
       the figure. The fixture pushes, so the previous row is taken out first;
       two rows for one key would leave the gate reading the old price and
       refusing, which is a fixture artefact and not the state under test. */
    await Enquiry.updateOne(
      { _id: w.enquiry._id },
      { $pull: { costLedger: { productLineRef: w.sand.ref } } },
    );
    await giveFloor(w, "sand", 750, 15200, {
      priceMinor, ledgerPrice, standing: "BELOW_FLOOR", versionNumber: 2, reuseCosting: true,
    });
  };

  test("a changed state is refused by name, and nothing second is created", async () => {
    const w = await world();
    await ready(w);
    const first = await call(w, { actionKey: "first" });

    await moveTo(w, 13000, 130);

    await expect(call(w, { actionKey: "second" })).rejects.toMatchObject({
      code: "PROFORMA_ALREADY_RAISED",
      details: { reason: "SUPERSESSION_REQUIRED", requestId: first.requestId },
    });
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });

  test("naming the current document raises a successor and leaves the first one alone", async () => {
    const w = await world();
    await ready(w);
    const first = await call(w, { actionKey: "first" });
    const beforeLines = await storedLines(first._id);

    await moveTo(w, 13000, 130);
    const successor = await call(w, { actionKey: "second", supersedes: String(first._id) });

    expect(String(successor._id)).not.toBe(String(first._id));
    expect(successor.supersededRequestId).toBe(String(first._id));
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(2);

    /* NEVER DELETED, NEVER REWRITTEN. The predecessor still says exactly what
       it said, and the successor points back at it. */
    const predecessor = await CustomerRequest.findById(first._id).lean();
    expect(predecessor).not.toBeNull();
    expect(await storedLines(first._id)).toEqual(beforeLines);
    const next = await CustomerRequest.findById(successor._id).lean();
    expect(String(next.salesOrigin.supersedesRequestId)).toBe(String(first._id));
    const successorLine = (await storedLines(successor._id))[0];
    expect(successorLine.quantity).toBe(750);
    /* The successor carries the NEW approved price, and the predecessor still
       carries the old one. Two documents, two states, both true. */
    expect(successorLine.unitPrice).toBe(130);
    expect(beforeLines[0].unitPrice).toBe(120);
  });

  test("superseding something that is not the current document is refused", async () => {
    const w = await world();
    await ready(w);
    await call(w, { actionKey: "first" });
    await moveTo(w, 13000, 130);

    await expect(call(w, { actionKey: "second", supersedes: String(new mongoose.Types.ObjectId()) }))
      .rejects.toMatchObject({ code: "PROFORMA_SUPERSESSION_MISMATCH" });
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });

  test("a successor cannot be raised for a state that has not moved", async () => {
    const w = await world();
    await ready(w);
    const first = await call(w, { actionKey: "first" });

    const again = await call(w, { actionKey: "second", supersedes: String(first._id) });
    expect(again.replayed).toBe(true);
    expect(String(again._id)).toBe(String(first._id));
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });
});

describe("what a raised proforma tells the rest of the journey", () => {
  const readReadiness = (w) => fetch(`${base}/${w.enquiry._id}/proforma-readiness`, {
    headers: {
      Authorization: `Bearer ${w.me.token}`,
      "X-Costing-Company": String(w.co._id),
    },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  const ready = async (w) => {
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR" });
  };

  test("the read publishes the raised document, with the figures it was stamped with", async () => {
    const w = await world();
    global.__ACTOR__ = w.me.user;
    await ready(w);

    /* Before: nothing raised, and the read says so rather than staying
       silent — "no proforma" is an answer the screen has to be able to give. */
    expect((await readReadiness(w)).body.proforma).toBeNull();

    const created = await raise(w, { items: [item(w, "sand")] }, { key: "one" });
    const after = (await readReadiness(w)).body.proforma;

    expect(after.requestId).toBe(created.body.requestId);
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]).toMatchObject({
      productLineRef: w.sand.ref,
      quantity: 750,
      unitPriceMinor: 12000,
      totalMinor: 9000000,
    });
  });

  test("another company's raised proforma is not readable across the boundary", async () => {
    const w = await world();
    const stranger = await world();
    global.__ACTOR__ = stranger.me.user;
    await ready(stranger);
    await raise(stranger, { items: [item(stranger, "sand")] }, { key: "theirs" });

    /* w asks for THEIR enquiry, with w's own proven company. The answer is
       the one a non-existent enquiry gets — no reference, no figures, no
       confirmation that anything was raised at all. */
    global.__ACTOR__ = w.me.user;
    const foreign = await fetch(`${base}/${stranger.enquiry._id}/proforma-readiness`, {
      headers: {
        Authorization: `Bearer ${w.me.token}`,
        "X-Costing-Company": String(w.co._id),
      },
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

    expect(foreign.status).toBe(404);
    expect(foreign.body.proforma).toBeUndefined();
  });

  test("the journey records Purchase Invoice as in progress — through its own authority", async () => {
    /* ── NOT A BROWSER'S INFERENCE ────────────────────────────────────
       The lifecycle strip read "Not Started" beside an existing proforma
       because nothing ever told the journey. The command that raises the
       document tells it now, through `salesJourneyProgress` — the single
       writer of stage states — and only ever lifts `notStarted`. */
    const w = await world();
    await ready(w);
    expect((await SalesJourney.findById(w.journey._id).lean()).stageStates.purchaseInvoice).toBe("notStarted");

    await proformaRequest.createForEnquiry(w.ctx, String(w.enquiry._id), {
      customerId: String(w.customer._id), items: [item(w, "sand")], actionKey: "k", actor,
    });

    const j = await SalesJourney.findById(w.journey._id).lean();
    /* Purchase Invoice, not Cost & Invoicing: the two stages were folded into
       one on 24 Sep 2026, and raising the proforma is that stage's own work.
       Recording it against the retired stage is what used to leave a journey
       reading "Purchase Invoice: not started" with its invoice already out. */
    expect(j.stageStates.purchaseInvoice).toBe("inProgress");
    /* And nothing else moved: no stage was marked complete on the way past,
       and the pointer stayed where the people using it left it. */
    expect(j.currentStage).toBe((await SalesJourney.findById(w.journey._id).lean()).currentStage);
    expect(j.stageStates.styleSample).toBe("notStarted");
    expect(j.stageStates.costQuote).toBe("notStarted");

    /* The enquiry now knows its own request without a browser having opened
       it — which is what Production and the PI workbench both read. */
    const enq = await Enquiry.findById(w.enquiry._id).lean();
    expect(String(enq.customerRequestId)).toBe(String((await CustomerRequest.findOne({
      "salesOrigin.enquiryId": w.enquiry._id,
    }).lean())._id));
  });

  test("opening a proforma raised before any of this records the stage too", async () => {
    /* ── THE DOCUMENT THAT ALREADY EXISTED ────────────────────────────
       A proforma raised before the command recorded anything has no claim
       and no journey progress behind it. Opening it is the browser's one
       call to the server — `PATCH /link-request` — and that is where the
       journey hears about it, through the same authority and the same verb.
       Nothing is inferred in the page. */
    const w = await world();
    global.__ACTOR__ = w.me.user;
    await ready(w);
    const created = await raise(w, { items: [item(w, "sand")] }, { key: "one" });

    /* Put it back to how a pre-existing document looks: no claim, no stage
       state, no link on the enquiry. */
    await CustomerRequest.updateOne({ _id: created.body._id },
      { $unset: { "salesOrigin.commercialClaimId": "" } });
    await SalesJourney.updateOne({ _id: w.journey._id }, { $set: { "stageStates.costQuote": "notStarted" } });
    await Enquiry.updateOne({ _id: w.enquiry._id }, { $unset: { customerRequestId: "" } });

    const linked = await fetch(`${base}/${w.enquiry._id}/link-request`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${w.me.token}`,
        "X-Costing-Company": String(w.co._id),
      },
      body: JSON.stringify({ requestId: String(created.body._id) }),
    });
    expect(linked.status).toBe(200);

    const j = await SalesJourney.findById(w.journey._id).lean();
    expect(j.stageStates.purchaseInvoice).toBe("inProgress");
    expect(String((await Enquiry.findById(w.enquiry._id).lean()).customerRequestId))
      .toBe(String(created.body._id));

    /* And the claim it lost is computed back from what the document itself
       says, so it takes part in the guarantee again rather than being
       invisible to it. */
    const readBack = (await readReadiness(w)).body.proforma;
    expect(readBack.requestId).toBe(created.body.requestId);
    const again = await raise(w, { items: [item(w, "sand")] }, { key: "two" });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await CustomerRequest.countDocuments({ "salesOrigin.enquiryId": w.enquiry._id })).toBe(1);
  });

  test("a stage state somebody set by hand is never written over", async () => {
    const w = await world();
    await ready(w);
    await SalesJourney.updateOne({ _id: w.journey._id }, { $set: { "stageStates.costQuote": "waitingCustomer" } });

    await proformaRequest.createForEnquiry(w.ctx, String(w.enquiry._id), {
      customerId: String(w.customer._id), items: [item(w, "sand")], actionKey: "k", actor,
    });

    expect((await SalesJourney.findById(w.journey._id).lean()).stageStates.costQuote).toBe("waitingCustomer");
  });
});

/* ═══ 9 · THE PROFORMA DOCUMENT IS THE APPROVED DECISION ══════════════════ */

describe("the proforma document carries the decision, not a blank shell", () => {
  /**
   * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
   * Opening the proforma on a raised request showed the right customer, the
   * right product and the right quantity — and ₹0 a piece, ₹0 before tax, ₹0
   * total, under the words "Manual price — not linked to an approved costing".
   * The document the company had already approved at 750 × ₹120 = ₹90,000
   * opened as an empty shell asking Sales to type the approved figure back in.
   *
   * The editor built its opening lines with `unitPrice: 0`. The save door,
   * meanwhile, could only price a line through the approved-costing TIERS —
   * and this line's approved price is an executive exception BELOW the floor,
   * which no tier expresses: asking for "the floor" would have quoted ₹152 and
   * stamped it as approved.
   *
   * So a Sales-origin line is priced from the commercial decision frozen on
   * the request, re-verified against the issuance authority on every save.
   */
  const ready = async (w, side = "sand") => {
    await confirm(w, side, 750);
    await giveFloor(w, side, 750, 15200, { priceMinor: 12000, ledgerPrice: 120, standing: "BELOW_FLOOR" });
  };

  /** Raise the request the proforma is built on, the way the stage does. */
  const raiseFor = async (w, sides = ["sand"]) => {
    global.__ACTOR__ = w.me.user;
    const r = await raise(w, { items: sides.map((s) => item(w, s)) }, { key: `pi-${Date.now()}-${Math.random()}` });
    expect(r.status).toBe(201);
    return r.body._id;
  };

  /** The line a browser posts: identity, and whatever else the caller forges. */
  const line = (w, side, over = {}) => ({
    stockItemId: String(w[side].stock._id),
    sampleStyleId: String(w[side].style._id),
    productLineRef: w[side].ref,
    itemName: `PF polo ${side}`,
    description: `PF polo ${side}`,
    quantity: 750,
    unitPrice: 0,
    basePrice: 0,
    gstPercentage: 5,
    ...over,
  });

  const saveDraft = (w, requestId, items, over = {}) =>
    fetch(`${salesBase}/requests/${requestId}/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(over.me || w.me).token}`,
      },
      body: JSON.stringify({
        date: "2026-09-20", validUntil: "2026-10-04", status: "draft",
        items, paymentSchedule: [], termsAndConditions: "T", customAdditionalCharges: [],
        _syncRequestItems: true,
        ...over.body,
      }),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  const storedDraft = async (requestId) => {
    const doc = await CustomerRequest.findById(requestId).lean();
    return { request: doc, quotation: (doc.quotations || [])[0] || null };
  };

  test("an existing governed request hydrates 750 × ₹120 without the browser sending either", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    /* Not a price, not a quantity that matters, no tier, no provenance —
       exactly what the editor posts when it opens the document it was
       handed. */
    const r = await saveDraft(w, requestId, [line(w, "sand", { quantity: undefined, unitPrice: 0, basePrice: 0 })]);
    expect(r.status).toBe(200);

    const { quotation } = await storedDraft(requestId);
    expect(quotation.items).toHaveLength(1);
    expect(quotation.items[0].quantity).toBe(750);
    expect(quotation.items[0].unitPrice).toBe(120);
    expect(quotation.items[0].basePrice).toBe(120);
  });

  test("the stamp says an approved costing priced it, and that the approval was an exception", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);
    await saveDraft(w, requestId, [line(w, "sand")]);

    const { quotation } = await storedDraft(requestId);
    const src = quotation.items[0].costingSource;
    expect(src.source).toBe("APPROVED_COSTING");
    expect(src.priceBasis).toBe("SALES_APPROVED_DECISION");
    expect(src.approvalKind).toBe("EXECUTIVE");
    expect(src.unitPriceMinor).toBe(12000);
    expect(src.quantity).toBe("750");
    expect(src.costingVersionNumber).toBe(1);
    /* No tier: this price was not taken from one, and naming one would say a
       band approved a figure that a review approved. */
    expect(src.priceTier).toBeUndefined();
  });

  test("an ordinary approval is recorded as one", async () => {
    const w = await world();
    await confirm(w, "sand", 750);
    await giveFloor(w, "sand", 750, 15200, { priceMinor: 16000, ledgerPrice: 160 });
    const requestId = await raiseFor(w);
    await saveDraft(w, requestId, [line(w, "sand")]);

    const { quotation } = await storedDraft(requestId);
    expect(quotation.items[0].costingSource.approvalKind).toBe("COMMERCIAL");
    expect(quotation.items[0].unitPrice).toBe(160);
  });

  test("a forged 500 against a confirmed 750 is refused, and nothing is written", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    const r = await saveDraft(w, requestId, [line(w, "sand", { quantity: 500 })]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("QUOTATION_COMMERCIAL_STATE_CONFLICT");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
    expect((await storedDraft(requestId)).quotation).toBeNull();
  });

  test("a forged price is replaced by the approved one, whatever was sent", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    for (const forged of [0, 9, 999999]) {
      await saveDraft(w, requestId, [line(w, "sand", { unitPrice: forged, basePrice: forged })]);
      const { quotation } = await storedDraft(requestId);
      expect(quotation.items[0].unitPrice).toBe(120);
      expect(quotation.items[0].basePrice).toBe(120);
    }
  });

  test("a forged costingSource cannot reach the stored line", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    await saveDraft(w, requestId, [line(w, "sand", {
      unitPrice: 999,
      costingSource: {
        source: "APPROVED_COSTING", priceBasis: "SALES_APPROVED_DECISION",
        approvalKind: "COMMERCIAL", unitPriceMinor: 99900, costingVersionNumber: 99,
      },
    })]);

    const { quotation } = await storedDraft(requestId);
    expect(quotation.items[0].unitPrice).toBe(120);
    expect(quotation.items[0].costingSource.unitPriceMinor).toBe(12000);
    expect(quotation.items[0].costingSource.approvalKind).toBe("EXECUTIVE");
    expect(quotation.items[0].costingSource.costingVersionNumber).toBe(1);
  });

  test("the document totals ₹90,000 base, ₹4,500 GST and ₹94,500", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);
    const r = await saveDraft(w, requestId, [line(w, "sand")]);

    const { quotation } = await storedDraft(requestId);
    expect(quotation.items[0].priceBeforeGST).toBe(90000);
    /* 5% — the slab the displayed rule sets below ₹2,499 a piece. */
    expect(quotation.items[0].gstPercentage).toBe(5);
    expect(quotation.items[0].gstAmount).toBe(4500);
    expect(quotation.subtotalBeforeGST).toBe(90000);
    expect(quotation.totalGST).toBe(4500);
    expect(quotation.grandTotal).toBe(94500);
    expect(r.body.quotation.grandTotal).toBe(94500);
  });

  test("saving does not move the confirmed quantity, the approved price or the decision", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);
    const before = (await CustomerRequest.findById(requestId).lean()).items[0];

    /* `_syncRequestItems` is the flag that writes the document back onto the
       request. On a governed line that is backwards, and it used to write the
       GST-INCLUSIVE total over the approved base amount. */
    await saveDraft(w, requestId, [line(w, "sand", { quantity: 750, unitPrice: 120 })]);
    const after = (await CustomerRequest.findById(requestId).lean()).items[0];

    expect(after.totalQuantity).toBe(before.totalQuantity);
    expect(after.variants[0].quantity).toBe(750);
    expect(after.variants[0].estimatedPrice).toBe(90000);
    expect(after.totalEstimatedPrice).toBe(90000);
    expect(after.commercialDecision).toEqual(before.commercialDecision);
  });

  test("save, reload and save again is one draft, not three", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    const first = await saveDraft(w, requestId, [line(w, "sand")]);
    const reloaded = (await storedDraft(requestId)).quotation;
    const again = await saveDraft(w, requestId, [line(w, "sand")]);

    const { request, quotation } = await storedDraft(requestId);
    expect(request.quotations).toHaveLength(1);
    expect(quotation.quotationNumber).toBe(reloaded.quotationNumber);
    expect(quotation.grandTotal).toBe(94500);
    expect(first.body.quotation.quotationNumber).toBe(again.body.quotation.quotationNumber);
  });

  test("two tabs saving at once leave one draft", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    const [a, b] = await Promise.all([
      saveDraft(w, requestId, [line(w, "sand")]),
      saveDraft(w, requestId, [line(w, "sand")]),
    ]);

    /* One of them may lose the document's own version check. That is the
       right outcome — the other tab's draft stands — and it is reported as a
       retryable conflict naming the fix, never as a server error. */
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    for (const r of [a, b]) {
      if (r.status === 409) {
        expect(r.body.code).toBe("QUOTATION_CONCURRENT_SAVE");
        expect(r.body.retryable).toBe(true);
      }
    }

    const { request } = await storedDraft(requestId);
    expect(request.quotations).toHaveLength(1);
    expect(request.quotations[0].grandTotal).toBe(94500);
  });

  test("two colourways keep their own quantity, price and style", async () => {
    const w = await world();
    await ready(w, "sand");
    await confirm(w, "navy", 400);
    await giveFloor(w, "navy", 400, 15200, { priceMinor: 20000, ledgerPrice: 200, reuseCosting: false });
    const requestId = await raiseFor(w, ["sand", "navy"]);

    /* Posted with BOTH lines claiming the same figures — the shape a
       name-keyed editor produces. Each is priced from its own decision. */
    await saveDraft(w, requestId, [
      line(w, "sand", { quantity: undefined, unitPrice: 0 }),
      line(w, "navy", { quantity: undefined, unitPrice: 0 }),
    ]);

    const { quotation } = await storedDraft(requestId);
    const bySand = quotation.items.find((i) => String(i.sampleStyleId) === String(w.sand.style._id));
    const byNavy = quotation.items.find((i) => String(i.sampleStyleId) === String(w.navy.style._id));
    expect(bySand.quantity).toBe(750);
    expect(bySand.unitPrice).toBe(120);
    expect(bySand.productLineRef).toBe(w.sand.ref);
    expect(byNavy.quantity).toBe(400);
    expect(byNavy.unitPrice).toBe(200);
    expect(byNavy.productLineRef).toBe(w.navy.ref);
  });

  test("another company saving this proforma is told what a stranger is told", async () => {
    const w = await world();
    const stranger = await world();
    await ready(w);
    const requestId = await raiseFor(w);

    global.__ACTOR__ = stranger.me.user;
    const foreign = await saveDraft(w, requestId, [line(w, "sand")], { me: stranger.me });
    const missing = await fetch(`${salesBase}/requests/${new mongoose.Types.ObjectId()}/quotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${stranger.me.token}` },
      body: JSON.stringify({ items: [], status: "draft", validUntil: "2026-10-04" }),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.message).toBe(missing.body.message);
    expect((await storedDraft(requestId)).quotation).toBeNull();
  });

  test("a decision that has moved refuses the save and names the revision path", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);
    await saveDraft(w, requestId, [line(w, "sand")]);

    /* Re-priced and re-approved on the enquiry: the proforma in front of
       somebody is now about a state that has passed. */
    await Enquiry.updateOne({ _id: w.enquiry._id }, { $pull: { costLedger: { productLineRef: w.sand.ref } } });
    await giveFloor(w, "sand", 750, 15200, {
      priceMinor: 13000, ledgerPrice: 130, standing: "BELOW_FLOOR", versionNumber: 2, reuseCosting: true,
    });

    const r = await saveDraft(w, requestId, [line(w, "sand")]);
    expect(r.status).toBe(409);
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_SALES_DECISION_CHANGED");
    expect(r.body.lines[0].message).toMatch(/revision/i);
    /* And the draft that was already saved still says what it said. */
    expect((await storedDraft(requestId)).quotation.items[0].unitPrice).toBe(120);
  });

  test("a document with no Sales provenance keeps the manual price path", async () => {
    /* A request raised outside Cost & Invoicing — the historical and portal
       path. Nothing here governs it, and a typed price is still a price. */
    const w = await world();
    const legacy = await CustomerRequest.create({
      requestId: `REQ-LEGACY-${Date.now()}`,
      customerId: w.customer._id,
      customerInfo: { name: "Legacy buyer" },
      items: [{
        stockItemId: w.sand.stock._id,
        stockItemName: "Legacy garment",
        variants: [{ attributes: [], quantity: 10, estimatedPrice: 1000 }],
        totalQuantity: 10,
        totalEstimatedPrice: 1000,
      }],
      status: "pending",
    });

    global.__ACTOR__ = w.me.user;
    const r = await saveDraft(w, legacy._id, [{
      stockItemId: String(w.sand.stock._id),
      itemName: "Legacy garment",
      quantity: 10,
      unitPrice: 100,
      basePrice: 100,
      gstPercentage: 5,
    }]);

    expect(r.status).toBe(200);
    const { quotation } = await storedDraft(legacy._id);
    expect(quotation.items[0].unitPrice).toBe(100);
    expect(quotation.items[0].quantity).toBe(10);
    /* Manual, and it says so by carrying no provenance at all. */
    expect(quotation.items[0].costingSource?.source).toBeUndefined();
  });

  test("nothing confidential travels with the document", async () => {
    const w = await world();
    await ready(w);
    const requestId = await raiseFor(w);
    const r = await saveDraft(w, requestId, [line(w, "sand")]);

    const stamped = JSON.stringify((await storedDraft(requestId)).quotation);
    const answered = JSON.stringify(r.body.quotation);
    for (const secret of [
      "floorPriceMinor", "unitCostMinor", "totalCostMinor", "trueUnitCost", "markup",
      "fingerprint", "decisionReason", "standing", "wasBelowFloorException", "15200",
    ]) {
      expect(stamped).not.toContain(secret);
      expect(answered).not.toContain(secret);
    }
  });
});
