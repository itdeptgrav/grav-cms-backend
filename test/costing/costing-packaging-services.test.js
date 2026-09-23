// test/costing/costing-packaging-services.test.js
//
// Central Costing — PACKAGING AND OUTSIDE SERVICES GET REAL SOURCES.
//
// ── THE STATE THIS REPLACES ─────────────────────────────────────────────────
// Both families were AWAITING_SOURCE. Packaging items existed in the item
// master and could carry supplier quotations; nothing connected a garment to
// them. Outside services had a Service Master of what the company BUYS and no
// record of what a style REQUIRES, and no quotation register at all — the only
// rates anywhere were `ServiceOrder.lines[].rate` and
// `SpendRequest.lines[].rate`, both of which exist only after somebody has
// already decided to buy, and `Service.defaultRate`, which says of itself that
// it is planning guidance.
//
// So a costing answered both with a hand-typed override, and the override was
// the only thing standing between a garment and shipping unpacked for free.
//
// ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────
// The whole slice, end to end: R&D's requirement, Store's dated quotation, the
// per-scenario resolution, the frozen provenance, and every way each of them
// can be wrong. Two claims matter more than the arithmetic and are asserted
// directly: a missing quantity is never a zero, and a default rate is never
// evidence.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

const { seedSourceBacked, configureProduction, prepareForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `pkg-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const TWO = [
  { key: "q500", label: "500", quantity: "500", isPrimary: true },
  { key: "q2000", label: "2000", quantity: "2000" },
];
const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

async function company(name) {
  return Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });
}

async function actor(co) {
  const n = ++seq;
  const email = `pkg-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `PK${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A configured company with a source-backed costing, seeded to order. */
async function world(seedOpts = {}) {
  const co = await company("Pkg");
  const me = await actor(co);
  const saved = await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  expect(saved.status).toBe(200);
  const seeded = await seedSourceBacked(co._id, seedOpts);
  await configureProduction(co._id);
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── THE RUN SIZES ARE THE SALES COSTING BRIEF'S ───────────────────────────
 * They travelled on this body. What quantities the customer wants priced is a
 * commercial decision Sales confirms on the enquiry, and the costing reads it
 * — so `calc` writes them where Sales writes them and posts only the lines.
 * Every test below keeps its own quantities and its own intent; what changed
 * is the record they are stated in. */
const writeBriefQuantities = async (w, scenarios) => {
  const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = (scenarios || []).map((sc, i) => ({
    key: String(sc.key || `q${i + 1}`),
    label: String(sc.label || sc.key || `q${i + 1}`),
    quantity: String(sc.quantity),
    isPrimary: sc.isPrimary === true || (scenarios.length === 1 && i === 0),
    ...(sc.proposedSellingPriceExclTax
      ? {
        proposedSellingPriceExclTax: String(
          sc.proposedSellingPriceExclTax.amountMinor !== undefined
            ? Number(sc.proposedSellingPriceExclTax.amountMinor) / 100
            : sc.proposedSellingPriceExclTax,
        ),
      }
      : {}),
  }));
  if (!enquiry.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    enquiry.costingBriefs[0].quantities[0].isPrimary = true;
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
};

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, and the engine is unchanged: the orchestration resolves the
   confirmed brief and every source and calls it.

   `lines` never reached the engine even before — the server assembles its own
   rows — so a body carrying only lines goes the Sales way. A body carrying
   anything ELSE is a payload-contract test, and those go to the retired door
   on purpose: its refusal is the contract now. */
const payloadContract = (body = {}) => Object.keys(body).some((k) => k !== "lines")
  /* A NON-EMPTY `lines` is a payload-contract test too. The engine assembles
     its own rows and ignored an empty list, but a list with something in it is
     a client trying to send a figure — which is exactly what those tests
     exist to see refused. */
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calc = async (w, scenarios = ONE, body = {}) => {
  await writeBriefQuantities(w, scenarios);
  if (payloadContract(body)) {
    return call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: [], ...body },
    });
  }
  return prepareForCosting(w.costingId);
};

const preview = (w) => call(`/${w.costingId}/technical-preview`, { token: w.me.token, company: w.co._id });

const lineIn = (version, key) => version.cost.scenarios
  .map((s) => s.lines.find((l) => l.lineKey === key)).filter(Boolean);
const scenarioOf = (version, key) => version.cost.scenarios.find((s) => s.key === key);
const provenanceFor = (version, key) =>
  (version.cost.offerProvenance || []).find((p) => p.lineKey === key) || null;

/* ═══ 1 · PACKAGING, PER GARMENT AND PER RUN ══════════════════════════════ */

describe("packaging is assembled from R&D's requirement and Store's quotation", () => {
  test("a per-garment bag scales with the run, at the quoted rate", async () => {
    /* One printed poly bag a garment at ₹2.50. Nothing is typed: R&D recorded
       the requirement on the sample and Store recorded the quotation. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const input = v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey);
    expect(input).toBeTruthy();
    expect(input.category).toBe("PACKAGING");
    expect(input.behaviour).toBe("PER_UNIT");
    expect(input.unitRate.amountMinor).toBe(250);
    /* Not PROVISIONAL: the server read it from a dated, referenced quotation
       rather than from somebody's recollection. */
    expect(input.confidence).toBe("SUPPLIER_QUOTATION");

    /* ── VARIABLE COST SCALES ──────────────────────────────────────────
       250 a garment at both run sizes; the TOTAL is what moves. */
    const [small, large] = ["q500", "q2000"].map((k) => scenarioOf(v, k));
    const pkg = (s) => s.categorySubtotals.find((c) => c.category === "PACKAGING");
    expect(pkg(small).perUnitMinor).toBe(250);
    expect(pkg(large).perUnitMinor).toBe(250);
    expect(pkg(small).totalMinor).toBe(125000);
    expect(pkg(large).totalMinor).toBe(500000);
  });

  test("a carton bought for the run dilutes across it, and is not multiplied by it", async () => {
    /* ── THE ERROR THIS PREVENTS ──────────────────────────────────────────
       Thirteen master cartons at ₹40 hold a 500-piece order. Treated as a
       per-garment quantity they would be 6,500 cartons — a hundredfold
       over-cost, and the supplier would be asked for a quantity that reaches
       a tier nobody earned. The basis is R&D's to state and is checked at
       binding, never inferred from the item. */
    const w = await world({
      packaging: { quantity: 13, unit: "Piece", basis: "FIXED_PER_RUN", rateMinor: 4000 },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const input = v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey);
    expect(input.behaviour).toBe("FIXED_PER_RUN");
    /* 13 x 4,000 = 52,000 for the order, whatever the run. */
    expect(input.amount.amountMinor).toBe(52000);
    expect(input.unitRate).toBeUndefined();

    const pkg = (k) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === "PACKAGING");
    expect(pkg("q500").totalMinor).toBe(52000);
    expect(pkg("q2000").totalMinor).toBe(52000);
    /* 52,000 / 500 = 104 a garment; 52,000 / 2,000 = 26. The dilution IS the
       economy of scale, and it is the reason the basis cannot be guessed. */
    expect(pkg("q500").perUnitMinor).toBe(104);
    expect(pkg("q2000").perUnitMinor).toBe(26);
  });

  test("a tier, a minimum order and an order multiple are all the supplier's own terms", async () => {
    /* 500 garments x 1 bag = 500 bags, which reaches the 500+ band at ₹2.00
       rather than the ₹2.50 base. */
    const w = await world({
      packaging: {
        quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250,
        moq: 100, orderMultiple: 50,
        tiers: [
          { minQuantity: 100, maxQuantity: 499, unitPriceMinor: 250 },
          { minQuantity: 500, unitPriceMinor: 200 },
        ],
      },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).unitRate.amountMinor).toBe(200);

    const prov = provenanceFor(v, w.seeded.packagingLineKey);
    expect(prov.priceSource).toBe("TIER");
    expect(prov.tierMinQuantity).toBe(500);
    expect(prov.moq).toBe(100);
    expect(prov.orderMultiple).toBe(50);
  });

  test("a run below the supplier's minimum is refused, naming the quantity", async () => {
    /* 500 bags against a 1,000 minimum. The company would have to buy more
       than the order needs, and the surplus is not something this engine
       models — so it stops rather than reporting a cost nobody can achieve. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250, moq: 1000 },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_BELOW_MOQ");
    expect(r.body.error.details.moq).toBe(1000);
    expect(r.body.error.details.purchaseQuantity).toBe("500");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);
  });

  test("a quantity off the supplier's order multiple is refused too", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250, orderMultiple: 300 },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_NOT_AN_ORDER_MULTIPLE");
    expect(r.body.error.details.orderMultiple).toBe(300);
  });
});

/* ═══ 2 · OUTSIDE SERVICES ════════════════════════════════════════════════ */

describe("an outside service is assembled from its requirement and a dated quotation", () => {
  test("a per-garment wash scales with the run", async () => {
    const w = await world({
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const input = v.cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey);
    expect(input.category).toBe("SERVICE");
    expect(input.unitRate.amountMinor).toBe(800);
    expect(input.confidence).toBe("SUPPLIER_QUOTATION");

    const svc = (k) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === "SERVICE");
    expect(svc("q500").perUnitMinor).toBe(800);
    expect(svc("q500").totalMinor).toBe(400000);
    expect(svc("q2000").totalMinor).toBe(1600000);
  });

  test("a fixed job-work charge dilutes across the run", async () => {
    /* Screen making: ₹2,500 for the order, once. */
    const w = await world({
      service: { quantity: 1, unit: "Lot", basis: "FIXED_PER_RUN", rateMinor: 250000 },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey).amount.amountMinor).toBe(250000);

    const svc = (k) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === "SERVICE");
    expect(svc("q500").totalMinor).toBe(250000);
    expect(svc("q2000").totalMinor).toBe(250000);
    expect(svc("q500").perUnitMinor).toBe(500);
    expect(svc("q2000").perUnitMinor).toBe(125);
  });

  test("a minimum charge is a floor under the total, not under the quantity", async () => {
    /* ── AND IT IS NOT AN MOQ ─────────────────────────────────────────────
       "₹8 a piece, minimum ₹5,000" means a 500-piece lot costs ₹5,000 rather
       than ₹4,000. Modelled as a minimum QUANTITY it would refuse the lot
       outright, which the supplier never said. */
    const w = await world({
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800, minimumChargeMinor: 500000 },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const svc = (k) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === "SERVICE");
    /* 500 x 800 = 400,000, floored up to the 500,000 minimum → 1,000/garment. */
    expect(svc("q500").totalMinor).toBe(500000);
    expect(svc("q500").perUnitMinor).toBe(1000);
    /* 2,000 x 800 = 1,600,000 clears the floor, so the quoted rate stands. */
    expect(svc("q2000").perUnitMinor).toBe(800);

    const prov = provenanceFor(v, w.seeded.serviceLineKey);
    expect(prov.minimumChargeMinor).toBe(500000);
    const small = prov.scenarios.find((s) => s.scenarioKey === "q500");
    expect(small.minimumChargeApplied).toBe(true);
    /* Both figures frozen, so the floor is visible doing its work rather than
       an unexplained total. */
    expect(small.lineNetBeforeMinimumMinor).toBe(400000);
    expect(small.lineNetMinor).toBe(500000);
    expect(prov.scenarios.find((s) => s.scenarioKey === "q2000").minimumChargeApplied).toBe(false);
  });

  test("a quoted band applies at the quantity that reaches it", async () => {
    const w = await world({
      service: {
        quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800,
        tiers: [
          { minQuantity: 1, maxQuantity: 999, unitPriceMinor: 800 },
          { minQuantity: 1000, unitPriceMinor: 650 },
        ],
      },
    });
    const r = await calc(w, TWO);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    const prov = provenanceFor(v, w.seeded.serviceLineKey);
    expect(prov.scenarios.find((s) => s.scenarioKey === "q500").quotedAmountMinor).toBe(800);
    expect(prov.scenarios.find((s) => s.scenarioKey === "q2000").quotedAmountMinor).toBe(650);
  });
});

/* ═══ 3 · NOBODY CHOOSES A SUPPLIER BY PRICE ══════════════════════════════ */

describe("several applicable quotations are a decision, never a default", () => {
  test("two service quotations block the save and return both candidates", async () => {
    /* Lead time, capacity and quality history all bear on it and none of them
       is in a rate, so the cheaper one is not chosen and neither is the first
       one the database returned. */
    const w = await world({
      service: {
        quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800,
        second: { rateMinor: 650 },
      },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ASSEMBLY_BLOCKED");
    expect(r.body.error.message).toMatch(/2 applicable quotations/);

    const candidates = r.body.error.details.candidates;
    expect(candidates).toHaveLength(2);
    /* Supplier order, never price order. */
    expect(candidates.map((c) => c.supplierName).map((s) => s.slice(0, 12)))
      .toEqual(["Wash House A", "Wash House B"]);
    expect(candidates.some((c) => c.selected)).toBe(false);
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);
  });

  test("naming one resolves it, and only the identity is sent", async () => {
    const w = await world({
      service: {
        quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800,
        second: { rateMinor: 650 },
      },
    });
    /* ── THE CHOICE IS NOT SENT WITH THE CALCULATION ANY MORE ─────────
       "The browser sends a quotation ID and nothing else" was true and was
       still the wrong app asking: which supplier does the washing weighs
       capacity and quality history, which is Store's. The identity-only
       discipline survives intact on Store's own path, where
       `sourcing-decisions.route.test.js` records a service quotation and
       checks the frozen provenance names it.

       Here, the calculation refuses to be told. */
    const r = await calc(w, ONE, {
      quotationChoices: { [w.seeded.serviceLineKey]: String(w.seeded.secondServiceOffer._id) },
    });
    /* ── AND REFUSED ONE STEP EARLIER NOW ─────────────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser's own refusal, which names Store and its
       destination, is asserted directly — the rule keeps a test even with no
       route that can carry a choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try {
      refuseQuotationChoices({
        quotationChoices: { [w.seeded.serviceLineKey]: String(w.seeded.secondServiceOffer._id) },
      });
    } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
    expect(told.details.decideAt).toMatch(/store/i);
  });

  test("a choice naming a quotation that does not apply is refused, not honoured", async () => {
    const w = await world({
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800, second: { rateMinor: 650 } },
    });
    await ServiceSupplierOffer.updateOne(
      { _id: w.seeded.secondServiceOffer._id },
      { $set: { status: "WITHDRAWN", withdrawalReason: "Capacity" } },
    ).catch(() => null);
    /* The model refuses a query update to a commercial field, so the
       withdrawal goes through the lifecycle door the routes use. */
    const doc = await ServiceSupplierOffer.findById(w.seeded.secondServiceOffer._id);
    doc.status = "WITHDRAWN";
    doc.withdrawalReason = "No capacity this season.";
    await ServiceSupplierOffer.beginServiceOfferLifecycle(doc, "WITHDRAW").save();

    /* Refused for two reasons, and the payload one comes first. That a
       withdrawn quotation is also refused on its merits is asserted against
       Store's path, where the decision is made and revalidated. */
    const r = await calc(w, ONE, {
      quotationChoices: { [w.seeded.serviceLineKey]: String(w.seeded.secondServiceOffer._id) },
    });
    /* ── AND REFUSED ONE STEP EARLIER NOW ─────────────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser's own refusal, which names Store and its
       destination, is asserted directly — the rule keeps a test even with no
       route that can carry a choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(r.body.versions).toBeUndefined();
  });
});

/* ═══ 4 · WHAT IS NEVER EVIDENCE ══════════════════════════════════════════ */

describe("a planning figure is not a costing rate", () => {
  test("Service.defaultRate never prices a line, even when nothing else can", async () => {
    /* ── THE WHOLE REASON THIS REGISTER EXISTS ───────────────────────────
       The Service Master carries a default rate and says of itself that it is
       "an estimate for planning, NOT an approved cost and not an invoice
       price". A costing that could reach it would eventually use it, and a
       frozen version would then cite a number with no supplier, no date and
       no reference behind it. */
    const w = await world({
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT" }, // no quotation
    });
    const master = await Service.findById(w.seeded.serviceMaster._id).lean();
    expect(master.defaultRate).toBe(99); // it is there, and it is not used

    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ASSEMBLY_BLOCKED");
    expect(r.body.error.message).toMatch(/no applicable service quotation/);
    /* Owned by the desk that can fix it. */
    expect(r.body.error.details.owner.department).toBe("Store / Purchase");
    /* And the default rate appears nowhere in the refusal. */
    expect(JSON.stringify(r.body)).not.toContain("\"defaultRate\"");
  });

  test("costing loads neither the Product BOM, a Service Order nor a spend request", () => {
    /* ── THE SAME RULE THE PRODUCT BOM ALREADY HAS ────────────────────────
       Guarded by scanning for a `require`, which is what "reads" means here.
       An id carried for identity is not a read — `technicalSource` holds a
       `stockItemId` and explicitly never resolves it — but a module that
       LOADS one of these models is one edit away from costing from it.

       `ServiceOrder` and `SpendRequest` are downstream of a decision to buy;
       a pre-production costing exists before either of them does. */
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "services", "centralCosting");
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const banned of ["StockItem", "ServiceOrder", "SpendRequest", "ProductBom"]) {
        if (new RegExp(`require\\([^)]*${banned}[^)]*\\)`, "i").test(src)) {
          offenders.push(`${f}: requires ${banned}`);
        }
      }
      /* And the planning rate is never read, by any spelling. */
      if (/\bdefaultRate\b/.test(src)) offenders.push(`${f}: reads defaultRate`);
    }
    expect(offenders).toEqual([]);
  });
});

/* ═══ 5 · A MISSING REQUIREMENT IS NEVER A ZERO ═══════════════════════════ */

describe("an unfinished technical row blocks the costing rather than vanishing", () => {
  test("packaging with no quantity is named and owned by R&D, not costed at nothing", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       An unimportable row is not carried into the assembled lines — correctly,
       since there is nothing to carry. Reported as a soft note, that made it a
       silent omission: the garment would be costed as though it shipped
       unpacked, and nothing on the version would say a row had been dropped. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $unset: { "sample.packagingRequirements.0.quantity": "" } },
    );

    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("R&D");
    expect(r.body.error.message).toMatch(/No quantity was recorded/i);
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);
  });

  test("a required service with no billing unit is R&D's row to finish", async () => {
    const w = await world({
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $set: { "sample.serviceRequirements.0.billingUnit": "" } },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No unit was recorded/i);
  });

  test("a requirement recorded and then excluded is kept on the record and left out of the cost", async () => {
    /* "We considered a hang tag and decided against it" is a fact worth
       having, and it is not a cost. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $set: { "sample.packagingRequirements.0.included": false, "sample.packagingRequirements.0.excludedReason": "Customer supplies bags." } },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].cost.inputs.find((l) => l.category === "PACKAGING")).toBeUndefined();

    const style = await SampleStyle.findById(w.seeded.style._id).lean();
    expect(style.sample.packagingRequirements[0].excludedReason).toBe("Customer supplies bags.");
  });
});

/* ═══ 6 · AN UNUSABLE SOURCE IS REFUSED PRECISELY ═════════════════════════ */

describe("an inactive, expired, withdrawn or foreign source is refused by name", () => {
  const withdraw = async (id) => {
    const doc = await ServiceSupplierOffer.findById(id);
    doc.status = "WITHDRAWN";
    doc.withdrawalReason = "Supplier retracted it.";
    await ServiceSupplierOffer.beginServiceOfferLifecycle(doc, "WITHDRAW").save();
  };

  test("a withdrawn service quotation cannot price a costing", async () => {
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    await withdraw(w.seeded.serviceOffer._id);
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/no current service quotation|withdrawn/i);
  });

  test("an expired service quotation is refused, judged against the costing date", async () => {
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    await ServiceSupplierOffer.collection.updateOne(
      { _id: w.seeded.serviceOffer._id },
      { $set: { validUntil: new Date("2020-01-01") } },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.versions).toBeUndefined();
  });

  test("a deactivated supplier's quotation is refused", async () => {
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    await Vendor.updateOne({ _id: w.seeded.serviceOffer.supplierId }, { $set: { status: "Inactive" } });
    const r = await calc(w, ONE);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.versions).toBeUndefined();
  });

  test("a service deactivated in the master is refused, and says which desk owns it", async () => {
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    await Service.updateOne({ _id: w.seeded.serviceMaster._id }, { $set: { status: "INACTIVE" } });
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/no longer active/i);
  });

  test("a requirement measured in one unit and quoted in another is refused, never converted", async () => {
    /* ── AND THIS IS WHY SERVICES ARE A SEPARATE REGISTER ─────────────────
       A service billing unit is deliberately outside the Unit Master. There
       is no factor between "per piece" and "per lot" to look up, and
       inventing one is a hundredfold error. */
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $set: { "sample.serviceRequirements.0.billingUnit": "Lot" } },
    );
    const r = await calc(w, ONE);
    /* Named precisely rather than as a generic block: the register considered
       the quotation and excluded it because the units do not meet, and the
       refusal carries that reason. */
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_CONVERSION_NOT_CONFIGURED");
    expect(r.body.error.message).toMatch(/not convertible/i);
  });
});

/* ═══ 7 · COMPANY ISOLATION ═══════════════════════════════════════════════ */

describe("neither register crosses a company boundary", () => {
  test("another company's service quotation is not a candidate", async () => {
    const w = await world({ service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 } });
    /* A quotation for the SAME service id, owned by somebody else. It must be
       invisible rather than excluded-with-a-reason: saying it exists would be
       an oracle. */
    const other = await company("Foreign");
    const foreignSupplier = await Vendor.create({
      companyId: other._id, companyName: "Foreign Washer", vendorType: "Supplier", status: "Active",
    });
    await ServiceSupplierOffer.create({
      companyId: other._id,
      supplierId: foreignSupplier._id, supplierName: foreignSupplier.companyName,
      serviceId: w.seeded.serviceMaster._id,
      billingUnit: "Piece", currency: "INR", unitPriceMinor: 1,
      priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18,
      quotationReference: "FOREIGN", status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
    });

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    /* Priced from OUR quotation, and the foreign one was never a choice. */
    expect(r.body.versions[0].cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey).unitRate.amountMinor).toBe(800);
    expect(JSON.stringify(r.body)).not.toContain("Foreign Washer");
  });

  test("another company's packaging quotation is not a candidate either", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    const other = await company("ForeignPkg");
    const foreignSupplier = await Vendor.create({
      companyId: other._id, companyName: "Foreign Packer", vendorType: "Supplier", status: "Active",
    });
    await SupplierOffer.create({
      companyId: other._id,
      supplierId: foreignSupplier._id, supplierName: foreignSupplier.companyName,
      itemId: w.seeded.packagingItem._id, purchaseUom: "Piece", currency: "INR",
      unitPriceMinor: 1, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
      freightTerms: "INCLUSIVE_LANDED",
      quotationReference: "FOREIGN-P", status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
    });

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).unitRate.amountMinor).toBe(250);
    expect(JSON.stringify(r.body)).not.toContain("Foreign Packer");
  });
});

/* ═══ 8 · WHAT THE VERSION FREEZES, AND WHAT IT SURVIVES ══════════════════ */

describe("frozen provenance is readable without the masters", () => {
  test("a packaging line freezes its requirement, item, supplier, quotation and quantities", async () => {
    const w = await world({
      packaging: { quantity: 2, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    const r = await calc(w, TWO);
    const v = r.body.versions[0];
    const prov = provenanceFor(v, w.seeded.packagingLineKey);

    expect(prov).toMatchObject({
      state: "SUPPLIER_QUOTATION",
      quotationReference: expect.stringMatching(/^QP-SB-/),
      priceBasis: "TAX_EXCLUSIVE",
      freightTerms: "INCLUSIVE_LANDED",
      gstRatePercent: 12,
      gstTreatment: "RECOVERABLE",
      purchaseUom: "Piece",
      consumptionUom: "Piece",
      conversionFactor: "1",
      quotedAmountMinor: 250,
      netRateMinor: 250,
      roundingMode: "HALF_UP",
      behaviour: "PER_UNIT",
      quantityPerUnit: "2",
    });
    /* Names, not only ids — a frozen version pointing at records that have
       since been renamed is a pointer, not evidence. */
    expect(prov.supplierName).toMatch(/^Packer/);
    expect(prov.itemName).toMatch(/^Poly Bag/);
    /* Derived quantities per scenario: 2 a garment is 1,000 bags at 500. */
    expect(prov.scenarios.map((s) => s.purchaseQuantity)).toEqual(["1000", "4000"]);
  });

  test("a service line freezes its own register's facts, including the tier and the floor", async () => {
    const w = await world({
      service: {
        quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800,
        minimumChargeMinor: 500000,
      },
    });
    const r = await calc(w, ONE);
    const prov = provenanceFor(r.body.versions[0], w.seeded.serviceLineKey);

    expect(prov).toMatchObject({
      state: "SUPPLIER_QUOTATION",
      family: "SERVICE",
      priceBasis: "TAX_EXCLUSIVE",
      gstRatePercent: 18,
      gstTreatment: "RECOVERABLE",
      billingUnit: "Piece",
      requestedUnit: "Piece",
      basis: "PER_GARMENT",
      quantityPerUnit: "1",
      priceSource: "BASE",
      minimumChargeMinor: 500000,
      minimumChargeApplied: true,
      roundingMode: "HALF_UP",
    });
    expect(prov.serviceCode).toMatch(/^SVC-SB-/);
    expect(prov.serviceName).toMatch(/^Garment Wash/);
    expect(prov.supplierName).toMatch(/^Wash House A/);
    expect(prov.quotationReference).toMatch(/^QS-SB-/);
    expect(prov.appliedServiceQuantity).toBe("500");
  });

  test("neither figure moves when the requirement, the item, the service or the quotation changes", async () => {
    /* ── THE CLAIM A FROZEN VERSION MAKES ─────────────────────────────────
       A costing from March still says what it costed, whatever happened
       since. Everything upstream is changed here — the technical quantity,
       the item's name, the service's name and status, and the quotation
       itself — and the version is re-read afterwards. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const before = r.body.versions[0];
    const versionId = before.id;

    await SampleStyle.updateOne({ _id: w.seeded.style._id }, {
      $set: {
        "sample.packagingRequirements.0.quantity": 9,
        "sample.serviceRequirements.0.quantity": 9,
      },
    });
    await Service.updateOne({ _id: w.seeded.serviceMaster._id },
      { $set: { name: "Renamed Wash", status: "INACTIVE", defaultRate: 100000 } });
    const pkgDoc = await SupplierOffer.findById(w.seeded.packagingOffer._id);
    pkgDoc.status = "WITHDRAWN";
    pkgDoc.withdrawalReason = "Renegotiated.";
    await SupplierOffer.beginOfferLifecycle(pkgDoc, "WITHDRAW").save();
    const svcDoc = await ServiceSupplierOffer.findById(w.seeded.serviceOffer._id);
    svcDoc.status = "WITHDRAWN";
    svcDoc.withdrawalReason = "Renegotiated.";
    await ServiceSupplierOffer.beginServiceOfferLifecycle(svcDoc, "WITHDRAW").save();

    const reread = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const after = reread.body.versions.find((x) => x.id === versionId);

    expect(after.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).unitRate.amountMinor).toBe(250);
    expect(after.cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey).unitRate.amountMinor).toBe(800);
    /* The snapshotted names are the ones that were true when it was costed. */
    expect(provenanceFor(after, w.seeded.serviceLineKey).serviceName).toMatch(/^Garment Wash/);
    expect(provenanceFor(after, w.seeded.serviceLineKey).serviceName).not.toBe("Renamed Wash");
    expect(scenarioOf(after, "q500").totalCostMinor).toBe(scenarioOf(before, "q500").totalCostMinor);
  });
});

/* ═══ 9 · WHAT THE SCREEN IS GIVEN, AND WHAT IT WILL BE ══════════════════ */

describe("the preview shows what the save will freeze", () => {
  test("packaging and services are their own source groups, with owner and basis", async () => {
    const w = await world({
      packaging: { quantity: 13, unit: "Piece", basis: "FIXED_PER_RUN", rateMinor: 4000 },
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    const p = await preview(w);
    expect(p.status).toBe(200);
    const rows = p.body.assembly.rows;

    expect(rows.packaging).toHaveLength(1);
    expect(rows.packaging[0]).toMatchObject({
      quantity: "13", unit: "Piece",
      basis: "FIXED_PER_RUN", basisLabel: "for the run",
      owner: "R&D", source: "SampleStyle packaging requirement",
    });
    expect(rows.services).toHaveLength(1);
    expect(rows.services[0]).toMatchObject({
      quantity: "1", unit: "Piece",
      basis: "PER_GARMENT", basisLabel: "per garment",
      owner: "R&D", source: "SampleStyle service requirement",
    });
    /* Not folded into materials — different rows, different desks, and a
       basis materials do not carry. */
    expect(rows.materials.some((m) => m.lineKey.startsWith("pkg:"))).toBe(false);
  });

  test("the preview's rate and the frozen rate are the same number", async () => {
    /* One assembly, used by both. Two implementations is how a figure changes
       on save with nothing saying it did. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    const p = await preview(w);
    const previewKeys = [
      ...p.body.assembly.rows.packaging.map((x) => x.lineKey),
      ...p.body.assembly.rows.services.map((x) => x.lineKey),
    ].sort();

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const savedKeys = r.body.versions[0].cost.inputs
      .filter((l) => ["PACKAGING", "SERVICE"].includes(l.category))
      .map((l) => l.lineKey).sort();
    expect(savedKeys).toEqual(previewKeys);

    /* ── AND THE PREVIEW IS HONEST ABOUT WHAT IT CANNOT KNOW ───────────
       A preview has no run size, so it cannot judge a minimum lot or a tier.
       Both rows read MISSING with the decision attached rather than claiming
       a rate that has not been checked against any quantity — "nothing has
       been ruled out because nothing has been asked". */
    expect(p.body.assembly.rows.packaging[0].state).toBe("MISSING");
    expect(p.body.assembly.rows.services[0].state).toBe("MISSING");
    /* One decision list, whatever the family — the screen renders one control
       rather than three that drift apart. The material's own decision is in
       there too, which is the point. */
    const decisions = p.body.assembly.quotationDecisions.map((d) => d.lineKey);
    for (const key of previewKeys) expect(decisions).toContain(key);
    expect(decisions.some((k) => k.startsWith("mat:"))).toBe(true);
    /* Each gap names the desk that can close it. */
    for (const d of p.body.assembly.quotationDecisions) {
      expect(d.owner.department).toMatch(/Store/);
    }
  });

  test("a family with a source no longer reads as one with none", async () => {
    /* Both were AWAITING_SOURCE, which is what sent people to type an
       override. They are AUTOMATIC now, and the awaiting message names the
       desk that can supply what is missing rather than offering a blank box. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
    });
    const p = await preview(w);
    const families = Object.fromEntries(p.body.assembly.coverage.families.map((f) => [f.key, f]));

    expect(families.packaging.authority).toBe("AUTOMATIC");
    expect(families.services.authority).toBe("AUTOMATIC");
    expect(families.packaging.awaitingMessage).not.toMatch(/override/i);
    expect(families.services.awaitingMessage).not.toMatch(/override/i);
    /* Development joined them in the chunk after this one — a requirement on
       the technical record, priced from a service quotation or the company's
       own published charge. */
    expect(families.development.authority).toBe("AUTOMATIC");
    expect(families.development.awaitingMessage).not.toMatch(/override/i);
    /* Freight followed in the chunk after that one. */
    expect(families.freight.authority).toBe("AUTOMATIC");
    /* And customs duty followed in the chunk after THAT one — the Board's
       approved tariff table read against Store's sourcing evidence. The claim
       this test makes is unchanged (a family with a source must not read like
       one with none); what changed is that duty is now on the answered side
       of it, and no family in this list is `AWAITING_SOURCE` any more. */
    expect(families.duty.authority).toBe("AUTOMATIC");
    expect(Object.values(families).map((fam) => fam.authority)).not.toContain("AWAITING_SOURCE");
  });
});

/* ═══ 9b · MEASURED AND PLANNED ARE DIFFERENT CLAIMS ═════════════════════ */

describe("a planned quantity stays provisional, however good the quotation", () => {
  test("a measured requirement with a live quotation reads and freezes as verified", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250, evidence: "SAMPLE_MEASURED" },
    });
    const p = await preview(w);
    expect(p.body.assembly.rows.packaging[0].evidence).toBe("SAMPLE_MEASURED");
    expect(p.body.assembly.rows.packaging[0].evidenceLabel).toBe("Measured on the sample");

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).confidence)
      .toBe("SUPPLIER_QUOTATION");
    expect(provenanceFor(v, w.seeded.packagingLineKey).evidence).toBe("SAMPLE_MEASURED");
  });

  test("a PLANNED requirement is provisional even with the same quotation behind it", async () => {
    /* ── A LINE IS AS GOOD AS ITS WEAKER HALF ────────────────────────────
       The rate is a dated, referenced quotation. The QUANTITY was specified
       for production and never demonstrated by a sample. Calling the line
       verified would hide exactly the difference the evidence field exists to
       record — and every row used to be stamped measured on the way in, which
       made the distinction unrecordable. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250, evidence: "BOM_PLANNED" },
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800, evidence: "BOM_PLANNED" },
    });

    const p = await preview(w);
    expect(p.body.assembly.rows.packaging[0].evidenceLabel).toBe("Planned for production");
    expect(p.body.assembly.rows.services[0].evidenceLabel).toBe("Planned for production");

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    /* Priced from the quotation — the RATE is not in doubt. */
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).unitRate.amountMinor).toBe(250);
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey).unitRate.amountMinor).toBe(800);
    /* And visibly provisional, which is what the existing completeness policy
       reads. */
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).confidence).toBe("PROVISIONAL");
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.serviceLineKey).confidence).toBe("PROVISIONAL");
    expect(v.warnings.some((x) => x.code === "PROVISIONAL_INPUTS")).toBe(true);

    /* Frozen, so a reader a year later can see which it was without the
       technical record still saying so. */
    expect(provenanceFor(v, w.seeded.packagingLineKey).evidence).toBe("BOM_PLANNED");
    expect(provenanceFor(v, w.seeded.serviceLineKey).evidence).toBe("BOM_PLANNED");
  });

  test("missing historical evidence stays missing at rest, and reads as planned", async () => {
    /* ── THE DEFAULT THIS REPLACES ────────────────────────────────────────
       The schema defaulted `evidence` to BOM_PLANNED, which looked safe and
       was still a claim it made on somebody's behalf — and it contradicted
       the write path, which REQUIRES the answer. A row could only acquire
       that value by never being asked, and at rest it then read identically
       to one where a person had chosen "planned".

       Missing stays missing on the document. The weaker reading is applied
       where the consequence lives: at the costing. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    await SampleStyle.updateOne(
      { _id: w.seeded.style._id },
      { $unset: { "sample.packagingRequirements.0.evidence": "" } },
    );

    /* Still absent — nothing wrote a value in on the way past. */
    const atRest = await SampleStyle.findById(w.seeded.style._id).lean();
    expect(atRest.sample.packagingRequirements[0].evidence).toBeUndefined();

    /* And a NEW row written with no evidence acquires none either. */
    const fresh = await SampleStyle.create({
      sampleStyleId: `SS-EV-${Date.now()}`, styleCode: "SC-EV", productName: "Evidence",
      sample: { packagingRequirements: [{ rawItemName: "Bag", quantity: 1, unit: "Piece" }] },
    });
    expect(fresh.sample.packagingRequirements[0].evidence).toBeUndefined();

    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    /* Read as planned, and never as measured. */
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.packagingLineKey).confidence)
      .toBe("PROVISIONAL");
    expect(provenanceFor(v, w.seeded.packagingLineKey).evidence).toBe("BOM_PLANNED");
  });
});

/* ═══ 10 · AND THE EXISTING FAMILIES ARE UNTOUCHED ═══════════════════════ */

test("material and labour costing are exactly what they were", async () => {
  /* The fixture's defaults: a metre of fabric at ₹100.00 and one operation at
     SAM 1.5 on an 18,000 salary with an 18% burden over 9,000 productive
     minutes — 18,000 x 1.18 / 9,000 x 1.5 = ₹3.54. Neither number moves
     because two new families were added beside them. */
  const w = await world({});
  const r = await calc(w, ONE);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];
  const by = Object.fromEntries(v.cost.scenarios[0].categorySubtotals.map((c) => [c.category, c.perUnitMinor]));
  expect(by.MATERIAL).toBe(10000);
  expect(by.OPERATION).toBe(354);
  expect(v.cost.scenarios[0].unitCostMinor).toBe(11596);
  /* And no empty packaging or service line was invented for a style that
     records neither. */
  expect(v.cost.inputs.some((l) => ["PACKAGING", "SERVICE"].includes(l.category))).toBe(false);
});

/* ═══ 7 · PACKAGING BOUGHT BY THE CARTON ══════════════════════════════════
 *
 * A poly bag is one per garment and scales smoothly. A master carton is one
 * per N garments, so its total STEPS: 500 garments at 25 to a carton is
 * twenty cartons, and 501 is twenty-one. Neither of the two bases that
 * existed could say that — `FIXED_PER_RUN` is the same money at every run
 * size, which is a shipping-mark plate, not a carton.
 *
 * The conversion is NOT a new field. `sample.shipment.garmentsPerCarton`
 * already existed, R&D-recorded, with this exact ceiling rule in its own
 * comment, and the freight family has read it since it was built. One style
 * states it once.
 */
describe("packaging costed per carton", () => {
  test("cartons are ceiling-divided, and the part carton is charged whole", async () => {
    const w = await world({
      packaging: {
        quantity: 1, unit: "Piece", basis: "PER_CARTON",
        garmentsPerCarton: 25, rateMinor: 4000,   // ₹40.00 a carton
      },
    });
    const r = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(201);

    const line = r.body.versions[0].cost.inputs.find((l) => l.category === "PACKAGING");
    /* Declared honestly: the frozen line still says it is a carton line
       rather than being collapsed into a fixed one that prices the same. */
    expect(line.behaviour).toBe("PER_CARTON");
    /* 500 / 25 = 20 cartons exactly, at ₹40 = ₹800.00 for the run. */
    expect(line.amount.amountMinor).toBe(80000);
  });

  test("501 garments buys twenty-one cartons, not twenty", async () => {
    /* The whole reason the basis exists. A part carton cannot be bought. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_CARTON", garmentsPerCarton: 25, rateMinor: 4000 },
    });
    const r = await calc(w, [{ key: "q501", label: "501", quantity: "501", isPrimary: true }]);
    expect(r.status).toBe(201);
    const line = r.body.versions[0].cost.inputs.find((l) => l.category === "PACKAGING");
    /* ceil(501/25) = 21 cartons × ₹40 = ₹840.00 — never 20, never 20.04. */
    expect(line.amount.amountMinor).toBe(84000);
  });

  test("each scenario buys its own carton count", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_CARTON", garmentsPerCarton: 25, rateMinor: 4000 },
    });
    const r = await calc(w, [
      { key: "q500", label: "500", quantity: "500", isPrimary: true },
      { key: "q600", label: "600", quantity: "600" },
    ]);
    expect(r.status).toBe(201);
    /* Read from the FROZEN input line: `cost.inputs` is the engine's
       normalised view of what it calculated, and the per-scenario table is an
       input to that calculation rather than an output of it. */
    const stored = await CostingVersion.findOne({ costingId: w.costingId }).sort({ versionNumber: -1 }).lean();
    const line = (stored.inputs || []).find((l) => l.category === "PACKAGING");
    /* A run total that STEPS: 20 cartons at 500, 24 at 600. A single amount
       reused across scenarios would under- or over-charge one of them. */
    expect(line.amountByScenario.q500.amountMinor).toBe(80000);
    expect(line.amountByScenario.q600.amountMinor).toBe(96000);
  });

  test("two liners per carton multiply the carton count, not the garment count", async () => {
    const w = await world({
      packaging: { quantity: 2, unit: "Piece", basis: "PER_CARTON", garmentsPerCarton: 25, rateMinor: 4000 },
    });
    const r = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    const line = r.body.versions[0].cost.inputs.find((l) => l.category === "PACKAGING");
    /* 20 cartons × 2 liners × ₹40 = ₹1,600 — not 500 × 2. */
    expect(line.amount.amountMinor).toBe(160000);
  });

  test("a carton basis with no conversion is REFUSED, never read as one-per-garment", async () => {
    /* Reading the absence as 1 gives one carton per garment — the costliest
       possible wrong answer, arrived at silently. */
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_CARTON", rateMinor: 4000 },
    });
    const r = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("R&D");
    expect(r.body.error.message).toMatch(/how many garments a carton holds/i);
    /* And nothing was frozen. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);
  });

  test("a per-garment bag still scales smoothly — the two bases stay distinct", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
    });
    const r = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(201);
    const line = r.body.versions[0].cost.inputs.find((l) => l.category === "PACKAGING");
    expect(line.behaviour).toBe("PER_UNIT");
    /* ₹2.50 each, every garment — no stepping, no ceiling. */
    expect(line.unitRate.amountMinor).toBe(250);
  });

  test("a frozen carton version does not move when the quotation later changes", async () => {
    const w = await world({
      packaging: { quantity: 1, unit: "Piece", basis: "PER_CARTON", garmentsPerCarton: 25, rateMinor: 4000 },
    });
    const first = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(first.status).toBe(201);
    const frozen = await CostingVersion.findOne({ costingId: w.costingId }).sort({ versionNumber: -1 }).lean();

    /* ── THE QUOTATION IS WITHDRAWN AFTERWARDS ────────────────────────
       Not edited: a supplier quotation is immutable by construction and
       refuses an update query outright, which is a stronger guarantee than
       this test needs to assume. Withdrawing it through the lifecycle is the
       real-world equivalent — the rate this version was built on is no
       longer quotable by anybody. */
    const offer = await SupplierOffer.findById(w.seeded.packagingOffer._id);
    offer.status = "WITHDRAWN";
    offer.withdrawalReason = "Supplier retracted the carton rate.";
    await SupplierOffer.beginOfferLifecycle(offer, "WITHDRAW").save();

    const after = await CostingVersion.findById(frozen._id).lean();
    const line = (after.inputs || []).find((l) => l.category === "PACKAGING");
    /* Still twenty cartons at the rate that was quoted when it was frozen —
       and still carrying its own per-scenario table and carton count. */
    expect(line.amount.amountMinor).toBe(80000);
    expect(line.amountByScenario.q500.amountMinor).toBe(80000);
    expect(line.garmentsPerCarton).toBe(25);
    expect(line.behaviour).toBe("PER_CARTON");

    /* ── AND THE PROVENANCE, NOT JUST THE MONEY ────────────────────────
       An amount nobody can trace is a number, not evidence. The version has
       to still say WHICH quotation produced it — from a supplier whose offer
       has since been withdrawn, which is exactly when somebody asks. */
    const prov = (after.offerProvenance || []).find((p) => p.lineKey === line.lineKey);
    expect(prov).toBeTruthy();
    expect(prov.offerId).toBeTruthy();
    expect(prov.supplierName).toBeTruthy();
    expect(prov.quotedAmountMinor).toBe(4000);
    expect(prov.currency).toBe("INR");

    /* And a NEW calculation now refuses, so the frozen figure is the only
       place that rate still exists. */
    const again = await calc(w, [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(again.status).toBe(409);
  });
});
