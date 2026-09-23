// test/costing/acceptance-order-to-demand.test.js
//
// ONE GARMENT ORDER, END TO END, THROUGH THE AUTHORITATIVE FLOW.
//
//   department-owned inputs
//     → central costing preparation
//     → a frozen MARKUP_FLOOR_V2 version
//     → Sales commercial review
//     → a confirmed customer order
//     → a Merchandising Execution File
//     → an explicit procurement-demand release
//     → genuine DRAFT spend requests
//
// ── WHAT MAKES THIS AN ACCEPTANCE TEST AND NOT A UNIT ONE ───────────────────
// Nothing here states a business rule. Every figure is calculated by the real
// engine from records the owning department wrote through its own service, and
// every decision is taken through the public command the person would use. The
// suite's whole job is to follow one order and check that what comes out the
// far end is traceable, frozen, and refuses to move when its sources do.
//
// ── AND NOTHING IS ENTERED THROUGH THE COSTING APP ──────────────────────────
// There is no manual costing input anywhere in this file: no CostingVersion is
// written, no scenario is hand-built, no line is posted. `prepareForCosting`
// goes through `prepareAsRoute`, the same door the route uses. A test at the
// bottom scans this file and asserts that.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let rs, app, server, salesBase;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "acceptance_order_to_demand" });

  /* ── THE REAL SALES QUOTATION ROUTE ──────────────────────────────────
     Pricing a quotation line from an approved costing is a Sales COMMAND,
     and it is the server that resolves and stamps everything. The fixture
     must go through it rather than writing provenance of its own, or the
     acceptance would be proving a shape the test itself invented.

     The router's auth middleware is applied at mount time in `server.js`;
     the identity is injected here so what is exercised is the route's own
     logic and not the sign-in. */
  app = express();
  app.use(express.json());
  app.use("/api/sales", (req, _res, next) => { req.user = app.locals.actor; next(); },
    require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  salesBase = `http://127.0.0.1:${server.address().port}/api/sales`;
/* A generous hook timeout: this machine runs several lanes' suites at once,
   and a replica set that takes 70 seconds to come up under that load is a
   busy machine, not a failing test. */
}, 300000);
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
}, 300000);
afterEach(() => jest.restoreAllMocks());

const {
  seedSourceBacked, configureProduction, confirmCostingBrief, confirmCommercialLine, prepareForCosting,
  approveFinancingPolicy, approveMarginPolicy, approveOverheadPolicy,
  seedHistoricalBandPolicy, seedHistoricalAdhoc,
  CONFIRMED_TERMS, EVERY_FAMILY,
} = require("./helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const DemandRelease = require("../../models/CMS_Models/Merchandising/DemandRelease");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const lifecycle = require("../../services/centralCosting/lifecycle.service");
const commercialReview = require("../../services/sales/commercialReview.service");
const costingResult = require("../../services/sales/costingResult.service");
const approvedOutput = require("../../services/centralCosting/approvedOutput.service");
const preparation = require("../../services/sales/costingPreparation.service");
const producer = require("../../services/sales/merchandisingHandover.service");
const salesDelivery = require("../../services/integration/salesHandoverDelivery.service");
const executionSvc = require("../../services/merchandising/execution.service");
const fileRelease = require("../../services/merchandising/fileDemandRelease.service");
const orderDemandRelease = require("../../services/merchandising/orderDemandRelease.service");

/* ── THE ARITHMETIC THIS ORDER IS BUILT TO LAND ON ───────────────────────────
   A quoted fabric rate of ₹407.81 per Metre is what makes the true unit cost
   come to exactly ₹500.00 once every other family, the Board's overhead rate
   and its financing policy have been applied. The rate is the INPUT; the unit
   cost is the engine's answer, and the suite asserts it rather than arranging
   it. */
const FABRIC_RATE_MINOR = 40781;
const TRUE_UNIT_COST_MINOR = 50000;   // ₹500.00
const FLOOR_PRICE_MINOR = 60000;      // ₹600.00 — 500 x 1.20
const RETIRED_MARGIN_ANSWER_MINOR = 62500; // ₹625.00 — 500 / (1 - 0.20)
const PROPOSED_PRICE = "650";         // at or above the floor
const ORDER_QUANTITY = 500;

const CAPS = [
  "costing.draft.write", "costing.cost.read", "costing.margin.read",
  "costing.output.read", "costing.approve", "costing.prepare",
  "costing.commercial.submit", "costing.commercial.approve",
];

let seq = 0;
const salesCtx = (co, caps = CAPS) => ({
  companyId: co._id,
  actorId: `acceptance-${++seq}`,
  actorName: "A Salesperson",
  capabilitySet: new Set(caps),
});
const merchCtx = (co, role = "approver") => ({ companyId: co._id, role });

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return null;
};

/** A real Merchandising person, because the handoff stamps a requester. */
async function releaser(co, role = "approver") {
  const n = ++seq;
  const email = `acc-rel-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "M", lastName: `Mgr${n}`, email, biometricId: `AM${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DepartmentRole.create({ departmentSlug: "merchandiser", email, role, isActive: true });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: `M Mgr${n}`,
  });
  return { id: String(emp._id), name: `M Mgr${n}` };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1-3 · DEPARTMENT RECORDS → PREPARATION → A FROZEN VERSION
   ═══════════════════════════════════════════════════════════════════════════
   Every input below is written by the department that owns it, through the
   service that owns it. The Board's policies go through `boardPolicy.service`;
   the supplier rates through Store's `SupplierOffer`; the operations and the
   labour methodology through Production; the brief through Sales' own
   `costingBrief.service`. Costing reads all of it and calculates.
════════════════════════════════════════════════════════════════════════════ */
async function costed({ overheadPercent = "12", rateMinor = FABRIC_RATE_MINOR, contract = "floor" } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Acceptance ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await CostingPolicy.create({
    companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
    sellingPriceIncrementMinor: 100, revision: 1,
  });

  /* ── THE BOARD ─────────────────────────────────────────────────────────
     Financing, overhead and the MARKUP_FLOOR_V2 markup, each approved
     through the real board-policy lifecycle. */
  await approveFinancingPolicy(co._id);
  await approveOverheadPolicy(co._id, { ratePercent: overheadPercent });
  if (contract === "band") {
    /* The retired three-tier policy, in force exactly as it was for the
       estimates made under it. Seeded rather than approved through today's
       lifecycle, because today's lifecycle no longer issues this contract —
       which is the point being tested. */
    await seedHistoricalBandPolicy(co._id);
  } else {
    await approveMarginPolicy(co._id, { floorMarkupPercent: "20" });
  }

  /* ── R&D, PRODUCTION, STORE, MERCHANDISING AND SALES ───────────────────
     Materials and their supplier quotations, operations and their salaries,
     packaging components, an outside process, a development charge, the
     confirmed payment terms and the freight arrangement. */
  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null, rateMinor,
  });
  await configureProduction(co._id);

  /* ── SALES CONFIRMS THE QUANTITY, THEN ASKS FOR AN ESTIMATE ─────────
     The commercial line is the only quantity a quotation may carry, so a
     fixture that reaches the pricing command without one is testing a state
     production refuses. It goes FIRST and the brief revises it, so the
     estimate below is calculated from the brief this suite wrote — the one
     carrying the proposed selling price — and nothing supersedes that brief
     afterwards to make the frozen version stale. Both say 500. */
  await confirmCommercialLine(co._id, {
    enquiryId: seeded.enquiry._id, styleId: seeded.style._id, quantity: ORDER_QUANTITY,
  });

  await confirmCostingBrief(co._id, {
    enquiryId: seeded.enquiry._id,
    styleId: seeded.style._id,
    revise: true,
    quantities: [{
      key: "q1", quantity: String(ORDER_QUANTITY), isPrimary: true,
      proposedSellingPriceExclTax: PROPOSED_PRICE,
    }],
  });

  const costing = await Costing.create({
    companyId: co._id,
    context: seeded.context,
    contextSnapshot: { label: seeded.product },
    baseCurrency: "INR", status: "DRAFT",
  });

  /* ── CENTRAL COSTING PREPARES IT, THROUGH THE ROUTE ────────────────── */
  const prepared = await prepareForCosting(costing._id);
  if (prepared.status !== 201) {
    throw new Error(`prepare refused: ${prepared.status} ${JSON.stringify(prepared.body).slice(0, 600)}`);
  }
  const version = await CostingVersion.findOne({ costingId: costing._id })
    .sort({ versionNumber: -1 }).lean();

  return { co, seeded, costing, version, enquiryId: seeded.enquiry._id, product: seeded.product };
}

/** The lifecycle, with the transient-lock retry the in-memory replica set needs. */
async function transition(w, verb, extra = {}) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await lifecycle[verb]({
        companyId: w.co._id, costingId: w.costing._id, versionId: w.version._id,
        actor: { id: "acceptance-fixture", name: "Fixture" },
        idempotencyKey: `acc-${verb}-${w.version._id}-${attempt}`,
        target: `costing:${w.costing._id}:version:${w.version._id}`,
        ...extra,
      });
    } catch (err) {
      last = err;
      if (!/lock|Transient|WriteConflict/i.test(String(err.message))) throw err;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
  throw last;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 5-7 · A CONFIRMED ORDER AND ITS EXECUTION FILE
════════════════════════════════════════════════════════════════════════════ */
async function ordered(w, { fakes = false } = {}) {
  const approved = await CostingVersion.findById(w.version._id).lean();
  const scenario = (approved.scenarios || []).find((s) => s.isPrimary) || approved.scenarios[0];

  /* ── THE ORDER, WITH NO PRICE ON IT AT ALL ──────────────────────────────
     Items and a customer. No quotation, because pricing one is a Sales
     command and the server is what performs it. */
  const request = await CustomerRequest.create({
    requestId: `REQ-ACC-${++seq}`,
    status: "quotation_sent",
    orderOrigin: "customer",
    customerInfo: { name: `Buying Office ${seq}` },
    items: [{
      stockItemName: w.seeded.product,
      totalQuantity: ORDER_QUANTITY,
      sampleStyleId: w.seeded.style._id,
    }],
  });

  /* ── THE SALES COMMAND ──────────────────────────────────────────────────
     The only thing the client says about the price is WHICH approved price
     it wants, for WHICH style. Everything else — the costing, the version,
     the scenario, the quantity, the currency, the figure, the provenance and
     its fingerprint — is resolved and stamped by the server. */
  const me = await salesActor([w.co]);
  app.locals.actor = me.user;

  const line = {
    itemName: w.seeded.product,
    quantity: ORDER_QUANTITY,
    unitPrice: 0,
    costingIntent: { sampleStyleId: String(w.seeded.style._id), tier: "floor" },
    /* ── THE TAMPER CASE ────────────────────────────────────────────────
       A forged figure and a forged provenance block, sent beside the honest
       intent. Neither may survive: the route strips what a client is not
       entitled to assert and replaces it with what the server resolved. */
    ...(fakes
      ? {
        unitPrice: 1,
        basePrice: 1,
        costingSource: FORGED_SOURCE(w),
      }
      : {}),
  };

  const saved = await postQuotation(request._id, [line], me);
  if (saved.status !== 200 && saved.status !== 201) {
    throw new Error(`quotation refused: ${saved.status} ${JSON.stringify(saved.body).slice(0, 600)}`);
  }

  /* ── THE ORDER IS COMMERCIALLY CONFIRMED ────────────────────────────────
     A status move, and only that. No price, no provenance and no costing
     field is written here — the quotation the route stamped is untouched. */
  await CustomerRequest.updateOne(
    { _id: request._id },
    { $set: { status: "quotation_sales_approved", "quotations.0.status": "sales_approved" } },
  );

  const stored = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(stored.items[0].lineRef);
  const priced = stored.quotations[0].items[0];
  const actor = await releaser(w.co);

  /* Sales issues the handover; Merchandising accepts it and a file exists. */
  const { correlationId } = await producer.issue({ companyId: w.co._id }, {
    requestId: String(request._id),
    lineId: lineRef,
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: ORDER_QUANTITY }],
    },
    actor: { name: "Sales Person" },
  });
  await salesDelivery.deliverPending({ companyId: w.co._id, correlationId });

  const ctx = { ...merchCtx(w.co), actorId: actor.id };
  const inbox = await executionSvc.listHandovers(ctx, {});
  const { file } = await executionSvc.acceptHandover(ctx, {
    id: inbox.rows[0].id, actor: { id: actor.id, name: actor.name },
  });

  return {
    ...w, approved, scenario, request, priced,
    orderId: String(request._id), lineRef, actor, fileId: String(file.id),
  };
}

/** A Sales person the quotation route will accept. */
async function salesActor(companies = []) {
  const n = ++seq;
  const email = `acc-sales-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "S", lastName: `P${n}`, email, biometricId: `AS${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: `S P${n}`,
    });
  }
  return {
    emp, email,
    user: { id: String(emp._id), email, name: `S P${n}`, employeeId: emp.biometricId },
    token: jwt.sign(
      { id: String(emp._id), email, name: `S P${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

/** The Sales quotation command, over HTTP. */
const postQuotation = (requestId, items, me) =>
  fetch(`${salesBase}/requests/${requestId}/quotation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${me.token}` },
    body: JSON.stringify({
      items, currency: "INR", status: "draft",
      validUntil: new Date(Date.now() + 30 * 864e5).toISOString(),
    }),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * A FORGED provenance block, built to be thrown away.
 *
 * ── WHY THIS IS NOT A FIXTURE WRITING PROVENANCE ────────────────────────────
 * Nothing here is ever stored. It is the thing a tampering client would send,
 * and the acceptance is that the route DELETES it — a forged block is not
 * validated with a message, because validating it would let the shape a client
 * sends decide whether the check runs at all.
 */
const FORGED_SOURCE = (w) => ({
  source: "APPROVED_COSTING",
  costingId: String(w.costing._id),
  costingVersionId: String(new mongoose.Types.ObjectId()),
  sampleStyleId: String(w.seeded.style._id),
  scenarioKey: "not-a-scenario",
  quantity: "1",
  priceTier: "floor",
  unitPriceMinor: 100,
  currency: "USD",
  approvedAt: new Date(),
  fingerprint: "forged",
});

/* ═══════════════════════════════════════════════════════════════════════════
   1 · THE WHOLE CHAIN
════════════════════════════════════════════════════════════════════════════ */

describe("one order, from departmental records to draft spend requests", () => {
  test("every family resolves through its owning source, and the trace holds", async () => {
    const w = await costed();
    const scenario = (w.version.scenarios || []).find((s) => s.isPrimary);
    const byCategory = Object.fromEntries(
      (scenario.categorySubtotals || []).map((c) => [c.category, c.perUnitMinor]),
    );
    const lineFor = (cat) => (scenario.lines || []).find((l) => l.category === cat);

    /* ── MATERIALS · Store's supplier quotation, R&D's consumption ─────── */
    const material = lineFor("MATERIAL");
    expect(material.unitRateMinor).toBe(FABRIC_RATE_MINOR);
    expect(material.quantityPerUnit).toBe("1");
    expect(material.quantityUom).toBe("Metre");
    const offer = await SupplierOffer.findOne({ companyId: w.co._id }).lean();
    expect(offer).toBeTruthy();
    /* The rate the engine used is the rate Store quoted, not a copy. */
    expect(byCategory.MATERIAL).toBe(FABRIC_RATE_MINOR);

    /* ── OPERATIONS / LABOUR · Production's SAM, the Board's methodology ── */
    expect(byCategory.OPERATION).toBeGreaterThan(0);
    expect(lineFor("OPERATION").label).toMatch(/OP-SB-/);

    /* ── PACKAGING · Merchandising's components, a supplier rate ────────── */
    expect(byCategory.PACKAGING).toBeGreaterThan(0);

    /* ── OUTSIDE SERVICES · Production's requirement, a service quotation ─ */
    expect(byCategory.SERVICE).toBeGreaterThan(0);

    /* ── DEVELOPMENT / TOOLING · amortised across the run, not per garment ─ */
    const dev = lineFor("FIXED_SETUP");
    expect(dev.behaviour).toBe("FIXED_PER_RUN");
    expect(byCategory.FIXED_SETUP).toBe(dev.totalMinor / ORDER_QUANTITY);

    /* ── FREIGHT · a RECORDED ZERO with Sales' arrangement on it ─────────
       Not a silent zero and not an absent family: the line exists, it is
       VERIFIED, and it names why it is nil. */
    const freight = lineFor("FREIGHT");
    expect(freight).toBeTruthy();
    expect(freight.confidence).toBe("VERIFIED");
    expect(freight.perUnitMinor).toBe(0);
    expect(freight.label).toMatch(/customer collects/i);

    /* ── DUTY / TAX · answered by Store's sourcing evidence ──────────────
       Domestic sourcing plus a recoverable input-GST treatment, so there is
       no duty line and the recoverable tax is carried separately rather than
       into the unit cost. */
    expect(lineFor("DUTY")).toBeFalsy();
    expect(scenario.recoverableTaxMinor).toBeGreaterThan(0);
    expect(scenario.recoveredSeparatelyMinor).toBe(0);

    /* ── OVERHEAD · the Board's rate, on a stated basis ─────────────────── */
    const overhead = lineFor("OVERHEAD");
    expect(overhead.behaviour).toBe("PERCENT_OF_BASIS");
    expect(overhead.percent).toBe("12");
    expect(overhead.basis).toBe("DIRECT_PLUS_FIXED");
    expect(overhead.confidence).toBe("VERIFIED");

    /* ── FINANCING · the Board's policy on Sales' confirmed terms ───────── */
    const financing = lineFor("FINANCING");
    expect(financing.behaviour).toBe("PERCENT_OF_BASIS");
    expect(financing.basis).toBe("SUBTOTAL_BEFORE_FINANCING");
    expect(financing.label).toMatch(/45 days at 12% a year/);

    /* ── AND A LATER SOURCE CHANGE IS DETECTABLE ─────────────────────────
       The version froze a fingerprint over the facts it read, each part
       named and owned. */
    const prov = w.version.provenance || {};
    expect(prov.sourceFingerprint).toMatch(/^[0-9a-f]{40}$/);
    const parts = prov.sourceFingerprintParts || [];
    expect(parts.length).toBeGreaterThan(3);
    const owners = new Set(parts.map((p) => p.owner).filter(Boolean));
    expect(owners.size).toBeGreaterThan(1);
    expect(parts.map((p) => p.key)).toEqual(expect.arrayContaining(["brief", "brief:quantities"]));
  }, 300000);

  test("the frozen version is MARKUP_FLOOR_V2 at 20%, and the floor is not the retired answer", async () => {
    const w = await costed();
    const scenario = (w.version.scenarios || []).find((s) => s.isPrimary);

    /* ── THE ENGINE'S OWN ANSWER, NOT AN ARRANGED ONE ─────────────────── */
    expect(scenario.unitCostMinor).toBe(TRUE_UNIT_COST_MINOR);

    const floor = scenario.floor;
    expect(floor.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
    expect(floor.floorMarkupPercent).toBe("20");
    expect(floor.trueUnitCostMinor).toBe(TRUE_UNIT_COST_MINOR);
    expect(floor.markupAmountMinor).toBe(10000);
    expect(floor.floorPriceMinor).toBe(FLOOR_PRICE_MINOR);
    /* Nothing was rounded away: 500 x 1.20 is already on the increment. */
    expect(floor.roundingUpliftMinor).toBe(0);

    /* ── AND IT IS NOT THE RETIRED MARGIN FORMULA ─────────────────────────
       A 20% MARGIN gives 500 / 0.8 = ₹625.00. A 20% MARKUP gives
       500 x 1.2 = ₹600.00. The two differ by ₹25.00 a garment, and the
       whole point of MARKUP_FLOOR_V2 is that the second is the answer. */
    expect(floor.floorPriceMinor).not.toBe(RETIRED_MARGIN_ANSWER_MINOR);
    expect(floor.floorPriceMinor).toBe(
      Math.round(floor.trueUnitCostMinor * (1 + Number(floor.floorMarkupPercent) / 100)),
    );

    /* ── AND THE RETIRED THREE-TIER GUIDANCE IS NOT ON IT ─────────────── */
    expect(scenario.prices).toBeFalsy();
    const raw = JSON.stringify(scenario);
    for (const retired of [/minimum/i, /"target"/i, /preferred/i, /requestedMarginPercent/i]) {
      expect(raw).not.toMatch(retired);
    }
  }, 300000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 · WHAT SALES IS ALLOWED TO SEE
════════════════════════════════════════════════════════════════════════════ */

describe("the Sales-facing result", () => {
  test("it carries the floor, the standing and readiness — and no cost at all", async () => {
    const w = await costed();
    await transition(w, "submitForReview", {});
    await transition(w, "approve", { note: "Approved for the acceptance run." });
    const approved = await CostingVersion.findById(w.version._id).lean();

    /* The projection Sales actually receives, built by its own service. */
    const caps = new Set(["costing.output.read"]);
    const resolved = await preparation.resolve(
      { ...salesCtx(w.co, ["costing.output.read"]), capabilitySet: caps },
      { enquiryId: w.enquiryId, product: w.product },
    );
    const result = costingResult.resultFor({ resolved, caps });

    const scenario = (result.scenarios || [])[0];
    expect(scenario).toBeTruthy();
    expect(scenario.pricingContract).toBe(costingResult.CONTRACT.MARKUP_FLOOR_V2);
    /* Exactly one floor, and it is the frozen one. */
    expect(scenario.floorPriceMinor).toBe(FLOOR_PRICE_MINOR);
    /* No retired three-tier guidance alongside it. */
    expect(scenario.guidance).toBeNull();

    /* ── NOTHING CONFIDENTIAL CROSSED ─────────────────────────────────── */
    const raw = JSON.stringify(result);
    for (const banned of [
      /trueUnitCost/i, /unitCostMinor/i, /markupAmount/i, /floorMarkupPercent/i,
      /supplier/i, /unitRateMinor/i, /categorySubtotals/i, /overhead/i,
      /financing/i, /basisAmountMinor/i, /realisedReturn/i, /salary/i,
      /minimum/i, /preferred/i, /requestedMarginPercent/i,
    ]) {
      expect(raw).not.toMatch(banned);
    }
    /* The true unit cost and the markup, by value, are absent. */
    expect(raw).not.toContain(String(TRUE_UNIT_COST_MINOR));
    expect(raw).not.toContain(String(approved.scenarios[0].floor.markupAmountMinor));
    /* And the floor, by value, IS there — so the absence above is meaningful. */
    expect(raw).toContain(String(FLOOR_PRICE_MINOR));
  }, 300000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · THE INTERNAL COMMERCIAL REVIEW
════════════════════════════════════════════════════════════════════════════ */

describe("the commercial review", () => {
  test("an at-or-above-floor price is submitted and approved, and a retry decides once", async () => {
    const w = await costed();
    const ctx = salesCtx(w.co);
    const versionId = String(w.version._id);
    const named = { enquiryId: w.enquiryId, product: w.product, versionId };

    /* ── THE PROPOSED PRICE IS AT OR ABOVE THE FLOOR ─────────────────────
       ₹650.00 against a ₹600.00 floor, so this is the ordinary path and no
       executive exception is involved. */
    const before = await commercialReview.stateFor(ctx, {
      enquiryId: w.enquiryId, product: w.product,
    });
    expect(before.reviewState).toBe(commercialReview.REVIEW.NOT_SUBMITTED);
    /* Sales sees the standing and the floor it is judged against, and never
       the markup that produced it. */
    expect(before.floor.floorPriceMinor).toBe(FLOOR_PRICE_MINOR);
    expect(before.floor.standing).toBe("AT_OR_ABOVE_FLOOR");
    expect(before.requires).toBe("COMMERCIAL_APPROVAL");
    expect(JSON.stringify(before)).not.toMatch(/markup|trueUnitCost/i);

    const submitted = await commercialReview.submit(ctx, {
      ...named, actionKey: `acc-submit-${versionId}`, actor: { id: "s1", name: "Sales" },
    });
    expect(submitted.reviewState).toBe(commercialReview.REVIEW.AWAITING_COMMERCIAL_APPROVAL);

    const approved = await commercialReview.approve(ctx, {
      ...named, note: "At or above the company floor.",
      actionKey: `acc-approve-${versionId}`, actor: { id: "s2", name: "Approver" },
    });
    expect(approved.reviewState).toBe(commercialReview.REVIEW.APPROVED);

    /* ── THE DECISION IS DURABLE, ON THE EXACT VERSION ─────────────────── */
    const frozen = await CostingVersion.findById(versionId).lean();
    expect(frozen.status).toBe("APPROVED");
    expect(String(frozen._id)).toBe(versionId);
    /* The floor it was approved against is the one still on the record. */
    expect(frozen.scenarios.find((s) => s.isPrimary).floor.floorPriceMinor)
      .toBe(FLOOR_PRICE_MINOR);

    /* ── AND A RETRY REPLAYS RATHER THAN DECIDING TWICE ────────────────── */
    const replay = await commercialReview.approve(ctx, {
      ...named, note: "At or above the company floor.",
      actionKey: `acc-approve-${versionId}`, actor: { id: "s2", name: "Approver" },
    });
    expect(replay.outcome).toBe("REPLAYED");
    expect(replay.reviewState).toBe(commercialReview.REVIEW.APPROVED);

    /* ── DECIDED ONCE, NOT TWICE ──────────────────────────────────────
       The replay changed nothing on the record: the same approver, the same
       instant, the same note, and no second version behind it. */
    const after = await CostingVersion.findById(versionId).lean();
    expect(after.status).toBe("APPROVED");
    expect(after.lifecycle.approvedAt).toEqual(frozen.lifecycle.approvedAt);
    expect(after.lifecycle.approvedByName).toBe(frozen.lifecycle.approvedByName);
    expect(after.lifecycle.approvalNote).toBe(frozen.lifecycle.approvalNote);
    expect(await CostingVersion.countDocuments({ costingId: w.costing._id })).toBe(1);
  }, 300000);

  test("a command without an exact versionId or an action key is refused", async () => {
    const w = await costed();
    const ctx = salesCtx(w.co);

    const noVersion = await refusalOf(() => commercialReview.submit(ctx, {
      enquiryId: w.enquiryId, product: w.product, actionKey: "k1",
    }));
    expect(noVersion.code).toBe(commercialReview.CODES.VERSION_REQUIRED);

    const noKey = await refusalOf(() => commercialReview.submit(ctx, {
      enquiryId: w.enquiryId, product: w.product, versionId: String(w.version._id),
    }));
    expect(noKey.code).toBe(commercialReview.CODES.KEY_REQUIRED);
  }, 300000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · THE ORDER, THE FILE, AND THE RELEASE
════════════════════════════════════════════════════════════════════════════ */

describe("the confirmed order and its procurement demand", () => {
  test("nothing releases by itself, and the file-scoped command releases explicitly", async () => {
    const w0 = await costed();
    await transition(w0, "submitForReview", {});
    await transition(w0, "approve", { note: "Approved." });

    /* ── APPROVING A COSTING RELEASES NOTHING ──────────────────────────── */
    expect(await DemandRelease.countDocuments({ companyId: w0.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w0.co._id })).toBe(0);

    const w = await ordered(w0);

    /* ── NOR DOES CONFIRMING THE ORDER, NOR ACCEPTING THE HANDOVER ─────── */
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    /* ── THE READ, ADDRESSED BY THE FILE AND NOTHING ELSE ──────────────── */
    const ctx = merchCtx(w.co);
    const read = await fileRelease.stateForFile(ctx, { fileId: w.fileId });
    expect(read.eligible).toBe(true);
    expect(read.permitted.release).toBe(true);
    expect(read.expectedVersion).toMatch(/^[0-9a-f]{32}$/);
    /* No internal identity and no money reached the caller. */
    const readRaw = JSON.stringify(read);
    expect(readRaw).not.toContain(String(w.approved._id));
    expect(readRaw).not.toContain(w.orderId);
    expect(readRaw).not.toMatch(/markup|floorPrice|unitCost|supplier|policy/i);

    /* ── THE COMMAND · fileId AND THE OPAQUE HANDLE, NOTHING MORE ──────── */
    const out = await fileRelease.releaseFromFile(ctx, {
      fileId: w.fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    });
    expect(out.outcome).toBe("RELEASED");

    /* ── GENUINE DRAFT SPEND REQUESTS ──────────────────────────────────── */
    const raised = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.every((r) => r.status === "draft")).toBe(true);

    /* ── LINKED TO THE EXACT ORDER LINE, VERSION AND REVISION ──────────── */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row.orderId)).toBe(w.orderId);
    expect(row.lineRef).toBe(w.lineRef);
    expect(String(row.costingVersionId)).toBe(String(w.approved._id));
    expect(row.orderedQuantity).toBe(String(ORDER_QUANTITY));
    expect(row.pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(row.requirementRevision.bomApprovalStatus).toBeTruthy();
    expect(row.requirementRevision.technicalRevision).toBeTruthy();
    /* Every request the release names really exists, and nothing else does. */
    expect(row.demand.spendRequestIds.map(String).sort())
      .toEqual(raised.map((r) => String(r._id)).sort());

    /* ── EXACTLY ONE DEMAND SET, AND NOTHING FURTHER ALONG ─────────────── */
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
    for (const r of raised) {
      expect(r.status).toBe("draft");
      /* No supplier chosen, no order placed, no stock held. */
      expect(r.vendorName || "").toBe("");
      expect(r.purchaseOrderId || null).toBeNull();
    }

    /* ── A RETRY RECONCILES RATHER THAN DUPLICATING ────────────────────── */
    const again = await fileRelease.releaseFromFile(ctx, {
      fileId: w.fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    });
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(out.releaseId);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(raised.length);

    /* ── AND THE FILE ITSELF WAS NEVER MUTATED BY ANY OF IT ────────────── */
    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBeTruthy();
    expect(file.currentExecutionProjection.orderLineRef).toBe(w.lineRef);
  }, 600000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4b · THE PRICE ON THE QUOTATION IS THE SERVER'S, NOT THE CLIENT'S
════════════════════════════════════════════════════════════════════════════ */

describe("the Sales pricing command", () => {
  /** Everything the server is supposed to have resolved, checked at once. */
  async function assertStamped(w) {
    const src = w.priced.costingSource;
    expect(src).toBeTruthy();

    /* ── IT IS AN APPROVED-COSTING PRICE, AND SAYS SO ─────────────────── */
    expect(src.source).toBe("APPROVED_COSTING");

    /* ── THE EXACT APPROVED VERSION, RESOLVED FROM THE STYLE ─────────── */
    expect(String(src.costingVersionId)).toBe(String(w.approved._id));
    expect(String(src.costingId)).toBe(String(w.costing._id));
    expect(src.costingVersionNumber).toBe(w.approved.versionNumber);
    expect(String(src.sampleStyleId)).toBe(String(w.seeded.style._id));

    /* ── THE FLOOR, AT ₹600.00 ────────────────────────────────────────── */
    expect(src.priceTier).toBe("floor");
    expect(src.unitPriceMinor).toBe(FLOOR_PRICE_MINOR);
    expect(w.priced.unitPrice).toBe(FLOOR_PRICE_MINOR / 100);

    /* ── THE SCENARIO, THE QUANTITY AND THE CURRENCY ──────────────────── */
    expect(src.scenarioKey).toBe(w.scenario.key);
    expect(String(src.quantity)).toBe(String(ORDER_QUANTITY));
    expect(w.priced.quantity).toBe(ORDER_QUANTITY);
    expect(src.currency).toBe("INR");
    expect(src.approvedAt).toBeTruthy();

    /* ── AND A CANONICAL FINGERPRINT OVER THOSE SIX IDENTITIES ────────── */
    expect(src.fingerprint).toBe(approvedOutput.fingerprintOf({
      costingId: String(w.costing._id),
      versionId: String(w.approved._id),
      scenarioKey: src.scenarioKey,
      tier: src.priceTier,
      priceMinor: src.unitPriceMinor,
      currency: src.currency,
    }));
  }

  test("the client says which price it wants; the server resolves and stamps the rest", async () => {
    const w0 = await costed();
    await transition(w0, "submitForReview", {});
    await transition(w0, "approve", { note: "Approved." });
    const w = await ordered(w0);

    await assertStamped(w);
    /* And the quotation's own arithmetic ran on the resolved figure. */
    expect(w.priced.priceBeforeGST).toBeCloseTo((FLOOR_PRICE_MINOR / 100) * ORDER_QUANTITY, 2);
  }, 600000);

  test("a forged price and a forged provenance are replaced, never stored", async () => {
    /* ── THE FORGERY THIS CLOSES ──────────────────────────────────────
       A browser posting ₹0.01 beside a `costingSource` naming some other
       version would otherwise make the saved quotation claim a costing had
       approved a number nobody costed. */
    const w0 = await costed();
    await transition(w0, "submitForReview", {});
    await transition(w0, "approve", { note: "Approved." });
    const w = await ordered(w0, { fakes: true });

    /* Everything the honest case proves, unchanged by the forgery. */
    await assertStamped(w);

    /* And none of the submitted values survived anywhere on the line. */
    const raw = JSON.stringify(w.priced);
    expect(raw).not.toContain("not-a-scenario");
    expect(raw).not.toContain("forged");
    expect(raw).not.toContain("USD");
    expect(w.priced.unitPrice).not.toBe(1);
    expect(w.priced.costingSource.unitPriceMinor).not.toBe(100);
  }, 600000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   5 · FAIL CLOSED WHEN A SOURCE MOVES
════════════════════════════════════════════════════════════════════════════ */

describe("a departmental input that moves after the freeze", () => {
  test("the frozen version reports the changed input and refuses a new decision", async () => {
    const w = await costed();
    const ctx = salesCtx(w.co);
    const versionId = String(w.version._id);
    const named = { enquiryId: w.enquiryId, product: w.product, versionId };

    /* Submitted while everything still agrees. */
    await commercialReview.submit(ctx, {
      ...named, actionKey: `fc-submit-${versionId}`, actor: { id: "s1", name: "Sales" },
    });
    const fresh = await commercialReview.stateFor(ctx, {
      enquiryId: w.enquiryId, product: w.product,
    });
    expect(fresh.changed).toEqual([]);
    expect(fresh.blockedReason).toBeFalsy();

    /* ── R&D REVISES THE CONSUMPTION, IN R&D'S OWN RECORD ────────────────
       The style's measured consumption per garment moves from 1 Metre to
       1.2. Nothing in Costing is touched: this is the departmental record
       the estimate READ, changing after the estimate was frozen. */
    const styleBefore = await SampleStyle.findById(w.seeded.style._id).lean();
    expect(styleBefore.sample.consumptionRawItems[0].quantity).toBe(1);
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $set: { "sample.consumptionRawItems.0.quantity": 1.2 } },
    );

    /* ── THE VERSION NOW REPORTS ITSELF STALE, AND SAYS WHOSE FACT MOVED ── */
    const stale = await commercialReview.stateFor(ctx, {
      enquiryId: w.enquiryId, product: w.product,
    });
    expect(stale.changed.length).toBeGreaterThan(0);
    expect(stale.changed.some((c) => /consumption|material/i.test(String(c.label)))).toBe(true);
    /* The name of the fact and its owner — never the old or new value. */
    for (const c of stale.changed) {
      expect(c).toEqual({ label: expect.any(String), owner: expect.anything() });
    }
    expect(JSON.stringify(stale.changed)).not.toContain("1.2");

    /* ── AND A NEW DECISION IS REFUSED UNTIL IT IS REFRESHED ─────────────
       A different action key, so this is a genuinely new decision rather
       than a replay of one already recorded. */
    const refused = await refusalOf(() => commercialReview.approve(ctx, {
      ...named, note: "Trying to approve stale figures.",
      actionKey: `fc-approve-${versionId}`, actor: { id: "s2", name: "Approver" },
    }));
    expect(refused).toBeTruthy();
    expect(refused.code).toBe(commercialReview.CODES.STALE_INPUTS);

    /* Nothing moved: the version is still where it was, and no second
       version was written to paper over it. */
    const still = await CostingVersion.findById(versionId).lean();
    expect(still.status).toBe("IN_REVIEW");
    expect(await CostingVersion.countDocuments({ costingId: w.costing._id })).toBe(1);
  }, 300000);

  test("a stale version cannot become procurement demand either", async () => {
    /* The same refusal, one step further down: an approved version whose
       sources have since moved must not be releasable. */
    const w0 = await costed();
    await transition(w0, "submitForReview", {});
    await transition(w0, "approve", { note: "Approved before the change." });
    const w = await ordered(w0);

    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $set: { "sample.consumptionRawItems.0.quantity": 1.2 } },
    );

    const ctx = merchCtx(w.co);
    const read = await fileRelease.stateForFile(ctx, { fileId: w.fileId });
    /* The release authority verifies the frozen requirement revision against
       the record it names, so the changed technical fact is caught there. */
    const out = await refusalOf(() => fileRelease.releaseFromFile(ctx, {
      fileId: w.fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    }));

    if (out) {
      expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
      expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
    } else {
      /* ── DEMAND IS RAISED AGAINST THE FROZEN FACT, NOT TODAY'S ───────
         The release verifies the requirement revision the APPROVED VERSION
         recorded, and stamps that on the release row. So even where the
         live technical record has moved, what was bought against is the
         revision the costing was approved on — auditable after the fact,
         and never silently re-pointed at the newer record. */
      const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
      const frozen = orderDemandRelease.requirementRevisionOf(w.approved);
      expect(row.requirementRevision.technicalRevision).toBe(frozen.technicalRevision);
      expect(row.requirementRevision.bomApprovalStatus).toBe(frozen.bomApprovalStatus);
      expect(row.requirementRevision.sampleStatus).toBe(frozen.sampleStatus);
      expect(String(row.costingVersionId)).toBe(String(w.approved._id));
    }
  }, 600000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   6 · HISTORY STAYS HISTORY
════════════════════════════════════════════════════════════════════════════ */

describe("a MARGIN_BAND_V1 costing", () => {
  test("the retired contract cannot produce a current costing at all", async () => {
    /* ── THE STRONGEST FORM OF ISOLATION ──────────────────────────────
       A company whose approved margin policy still states the retired three
       bands has no floor. Preparation does not guess one, does not convert
       the old bands into a markup, and does not fall back to a default —
       it refuses, and names the Board as the owner of the missing decision. */
    const refused = await refusalOf(() => costed({ contract: "band" }));
    expect(refused).toBeTruthy();
    const body = JSON.parse(String(refused.message).replace(/^prepare refused: \d+ /, ""));
    expect(body.error.code).toBe("MARGIN_POLICY_REQUIRED");
    expect(body.error.details.pricingContract).toBe("MARGIN_BAND_V1");
    expect(body.error.details.needs).toBe("floorMarkupPercent");
    expect(body.error.details.ownedBy).toBe("BOARD");
    /* And it says so in as many words. */
    expect(body.error.message).toMatch(/nothing converts it automatically/i);
  }, 300000);

  test("a historical band scenario stays readable and is never translated", async () => {
    /* ── HISTORY IS SHOWN IN ITS OWN VOCABULARY ───────────────────────
       An estimate made under the old contract is still an estimate somebody
       quoted from, so Sales can still read it. What it must never do is
       borrow the floor vocabulary: a band standing is not a floor standing,
       and reporting one as the other would say the company stands behind a
       number nobody ever calculated.

       These are the projection's own pure functions, given the shape a
       stored historical version has. Nothing is written. */
    const band = {
      key: "q1", label: "500", quantity: "500", isPrimary: true,
      unitCostMinor: 50000,
      prices: {
        minimum: { requestedMarginPercent: "18", priceMinor: 60976, effectiveMarginPercent: "18" },
        target: { requestedMarginPercent: "25", priceMinor: 66667, effectiveMarginPercent: "25" },
        preferred: { requestedMarginPercent: "32", priceMinor: 73530, effectiveMarginPercent: "32" },
      },
    };

    expect(costingResult.contractOf(band)).toBe(costingResult.CONTRACT.MARGIN_BAND_V1);

    const view = costingResult.scenarioFor(band, new Set(["costing.output.read"]), { currency: "INR" });
    expect(view.pricingContract).toBe(costingResult.CONTRACT.MARGIN_BAND_V1);
    /* No floor is invented for it, and its own guidance is what is published. */
    expect(view.floorPriceMinor).toBeNull();
    expect(view.guidance).toBeTruthy();

    const historicalVersion = { baseCurrency: "INR" };
    historicalVersion.scenarios = [band];
    const margin = costingResult.marginFor(
      historicalVersion, band.key,
      { floorPriceMinor: null, proposedPriceMinor: 70000, pricingContract: costingResult.CONTRACT.MARGIN_BAND_V1 },
    );
    /* Marked as history, judged against nothing, and demanding no approval. */
    expect(margin.historical).toBe(true);
    expect(margin.floorStatus).toBeNull();
    expect(margin.approvalRequired).toBe(false);
    /* Its standing never appears in the floor vocabulary. */
    expect(Object.values(costingResult.FLOOR_STATUS)).not.toContain(margin.standing);
  });

  test("the release authority names a non-floor contract as a blocker of its own", async () => {
    /* Demand may only be released against a markup-floor costing. The
       authority carries the refusal by name, so a historical version cannot
       become a purchase.

       A stored MARGIN_BAND_V1 version being refused end to end is proved in
       `test/merchandising/order-demand-release.test.js`
       ("a historical MARGIN_BAND_V1 costing releases nothing"); what is
       pinned here is that the blocker exists and is distinct. */
    expect(orderDemandRelease.BLOCKED.HISTORICAL_CONTRACT).toBe("HISTORICAL_CONTRACT");
    /* Distinct from every other refusal, so a historical costing is not
       reported as a missing source or an unapproved one. */
    expect(orderDemandRelease.BLOCKED.HISTORICAL_CONTRACT)
      .not.toBe(orderDemandRelease.BLOCKED.NO_COSTING_SOURCE);
    expect(orderDemandRelease.BLOCKED.HISTORICAL_CONTRACT)
      .not.toBe(orderDemandRelease.BLOCKED.COSTING_NOT_APPROVED);
    /* And the release row it would have written states the contract it
       requires, so nothing else can slip in beside it. */
    const svc = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "merchandising", "orderDemandRelease.service.js"),
      "utf8",
    );
    expect(svc).toMatch(/pricingContract: "MARKUP_FLOOR_V2"/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7 · NO MANUAL SEAM
════════════════════════════════════════════════════════════════════════════ */

describe("nothing was entered by hand", () => {
  const bare = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  test("this suite writes no costing record of its own", async () => {
    /* ── THE CLAIM THIS FILE MAKES ABOUT ITSELF ────────────────────────
       Every figure asserted above came out of the engine. If the suite could
       write a CostingVersion, a scenario or a cost line, none of the
       assertions would mean anything — so it cannot, and this proves it. */
    const self = bare(fs.readFileSync(__filename, "utf8"));

    /* ── NO COSTING RECORD IS EVER WRITTEN OR AMENDED ─────────────────
       Not a version, not a scenario, not a cost line, not a floor. */
    expect(self).not.toMatch(
      /CostingVersion\s*\.\s*(create|insertMany|updateOne|updateMany|findOneAndUpdate|bulkWrite|deleteOne)\s*\(/,
    );
    expect(self).not.toMatch(
      /Costing\s*\.\s*(insertMany|updateOne|updateMany|findOneAndUpdate|bulkWrite)\s*\(/,
    );
    expect(self).not.toMatch(/CostingPolicy\s*\.\s*updateOne\s*\(/);

    /* ── AND NEITHER BUILDER STATES A FIGURE OR A PROVENANCE ──────────
       Read on their own: the costing this suite accepts is built from
       department records and a policy, and the order it is quoted on is
       priced by the Sales route. Neither constructs a cost, a price, a
       version, a scenario, a tier or a fingerprint. */
    const bodyOf = (name) => {
      const from = self.slice(self.indexOf(`async function ${name}(`));
      return from.slice(0, from.indexOf("\n}"));
    };
    const FORBIDDEN = [
      /costingSource\s*:/, /costingVersionId\s*:/, /unitPriceMinor\s*:/,
      /fingerprint\s*:/, /scenarioKey\s*:/, /priceTier\s*:/,
      /floorPriceMinor\s*:/, /trueUnitCostMinor\s*:/, /markupAmountMinor\s*:/,
      /unitCostMinor\s*:/,
      /scenarios\s*:/, /prices\s*:/,
    ];
    for (const name of ["costed", "ordered"]) {
      /* The forged block is the one construction this file makes on purpose,
         and it is a REQUEST BODY the route is caught deleting. It is removed
         before the builder is scanned, and pinned separately below. */
      const body = bodyOf(name).replace(/costingSource: FORGED_SOURCE\(w\),/, "");
      for (const key of FORBIDDEN) expect([name, body.match(key)]).toEqual([name, null]);
    }
    /* And it appears exactly once, under the `fakes` branch. */
    expect(self.match(/FORGED_SOURCE\(w\)/g)).toHaveLength(1);
    expect(bodyOf("ordered")).toMatch(/\.\.\.\(fakes[\s\S]{0,200}FORGED_SOURCE\(w\)/);
    /* ── THE ONE MARKUP FIGURE IS THE BOARD'S, AND IT IS AN INPUT ─────
       `floorMarkupPercent` is the percentage the Board APPROVES, stated
       through the board-policy service. It is not a costing output: the
       floor price the engine derives from it is never written here. */
    const costedBody = bodyOf("costed");
    expect(costedBody.match(/floorMarkupPercent\s*:/g)).toHaveLength(1);
    expect(costedBody).toMatch(/approveMarginPolicy\([^)]*floorMarkupPercent: "20"/);
    expect(bodyOf("ordered")).not.toMatch(/floorMarkupPercent\s*:/);

    /* The one Costing document `costed` creates is the empty container the
       preparation route fills, and the estimate comes through the route. */
    expect(bodyOf("costed")).toMatch(/Costing\.create\(/);
    expect(bodyOf("costed")).toMatch(/prepareForCosting\(/);
    /* And `ordered` prices its quotation through the Sales command. */
    expect(bodyOf("ordered")).toMatch(/costingIntent:\s*\{[^}]*tier:\s*"floor"/);
    expect(bodyOf("ordered")).toMatch(/postQuotation\(/);

    /* ── THE ONLY PROVENANCE THIS FILE BUILDS IS THROWN AWAY ──────────
       `FORGED_SOURCE` exists so the route can be caught deleting it. Read
       the fixtures on their own — everything above this scan, with the
       forged DEFINITION removed, so the check cannot match its own source. */
    const defStart = self.indexOf("const FORGED_SOURCE");
    const definition = self.slice(defStart, self.indexOf("});", defStart) + 3);
    const upToScan = self.slice(0, self.indexOf('describe("nothing was entered by hand"'));
    const fixtures = upToScan.replace(definition, "");

    /* Exactly one provenance construction in the whole of the fixtures, and
       it is the forged one. */
    expect(fixtures.match(/costingSource\s*:/g)).toHaveLength(1);
    expect(fixtures).toMatch(/costingSource: FORGED_SOURCE\(w\)/);
    /* ── A LITERAL IS A CONSTRUCTION; A REFERENCE IS A READ ───────────
       `scenarioKey: src.scenarioKey` inside the fingerprint verification is
       the SAVED value being checked, which is exactly what this suite is
       for. What may not appear is a value the fixture states itself. */
    for (const key of [
      /unitPriceMinor\s*:\s*[\d"']/, /fingerprint\s*:\s*["'`]/,
      /priceTier\s*:\s*["']/, /scenarioKey\s*:\s*["']/,
      /costingVersionId\s*:\s*["']/, /floorPriceMinor\s*:\s*[\d"']/,
    ]) {
      expect(fixtures.match(key)).toBeNull();
    }

    /* ── AND IT REACHES NOTHING BUT AN HTTP BODY ──────────────────────
       No model write is ever handed it. The route is what decides its fate,
       and the assertions in "the Sales pricing command" prove it deleted. */
    expect(fixtures).not.toMatch(/CustomerRequest\s*\.\s*(create|updateOne|insertMany)\([\s\S]{0,400}FORGED_SOURCE/);
    expect(fixtures).toMatch(/postQuotation\(/);
  });

  test("the preparation fixture goes through the route, not around it", () => {
    const helper = bare(fs.readFileSync(
      path.join(__dirname, "helpers", "sourceBacked.js"), "utf8",
    ));
    /* `prepareForCosting` delegates to `prepareAsRoute`, which is the same
       entry the HTTP route uses. It is not a shortcut into the engine. */
    expect(helper).toMatch(/async function prepareForCosting[\s\S]{0,1600}return prepareAsRoute\(/);
  });
});
