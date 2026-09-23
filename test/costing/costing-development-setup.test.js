// test/costing/costing-development-setup.test.js
//
// Central Costing — DEVELOPMENT, PATTERN, TOOLING AND SETUP.
//
// ── THE FAMILY THIS CLOSES ──────────────────────────────────────────────────
// `development` / `FIXED_SETUP` was the last of the five AWAITING_SOURCE
// families still telling people to "enter a provisional override" — a figure
// with no supplier, no date and no reference, typed into the costing editor by
// whoever happened to be looking at it.
//
// Two authoritative paths replace it, and no third. Work bought outside is
// priced from the supplier's own dated service quotation; work the company
// does itself is priced from the development charge Finance published. Neither
// is typed, and a requirement may not name both.
//
// ── AND THE ARITHMETIC THAT MAKES IT WORTH DOING ────────────────────────────
// These are one-time costs. ₹10,000 of pattern work is ₹10,000 whether the
// order is 100 pieces or 1,000 — what changes is what each garment carries,
// and that difference IS the economy of scale a quotation is argued over.
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
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

const { seedSourceBacked, configureProduction, approveDevelopmentPolicy, prepareForCosting, assembleForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `dev-${++seq}-${Math.random().toString(36).slice(2)}`;

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

/* No overhead rule: the setup charge is what these figures are about, and a
   percentage on top would obscure the dilution being asserted. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

/* The three run sizes the economy of scale is argued over. */
const THREE = [
  { key: "q100", label: "100", quantity: "100", isPrimary: true },
  { key: "q500", label: "500", quantity: "500" },
  { key: "q1000", label: "1000", quantity: "1000" },
];
const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

/** ₹10,000, in the integer minor units everything here speaks. */
const TEN_THOUSAND = 1000000;

async function world(seedOpts = {}, { charges = null } = {}) {
  const co = await Acc_Company.create({ companyName: `Dev ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const n = ++seq;
  const email = `dev-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `DV${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );

  const saved = await call("/policy/current", { method: "PUT", token, company: co._id, body: POLICY });
  expect(saved.status).toBe(200);
  /* ── THE CATALOGUE IS APPROVED, NOT POSTED ────────────────────────────
     What the company charges for its own development work is a Board policy
     now. The costing-policy route refuses to write it, so the fixture
     approves a catalogue instead — which is also what a company would have
     to do. */
  if (charges) await approveDevelopmentPolicy(co._id, charges);

  const seeded = await seedSourceBacked(co._id, { withMaterial: false, withOperation: false, ...seedOpts });
  /* ── NO OVERHEAD IN THIS WORLD ────────────────────────────────────────
     Every figure this suite asserts is stated to the paisa, so a 12% company
     overhead on top would be counted into all of them. Overhead's own
     participation is proved in board-overhead-costing and costing-corrections;
     what is under test here is something else. */
  await configureProduction(co._id, { overhead: null });
  const made = await call("/", {
    method: "POST", token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, token, seeded, costingId: made.body.costing.id };
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
   the ENGINE, which is unchanged — the orchestration resolves the brief and
   the sources and calls it. A call carrying a BODY still goes to the retired
   door on purpose: those tests are about the payload contract, and its
   refusal is the contract now. */
const calc = async (w, scenarios = ONE, body = {}) => {
  await writeBriefQuantities(w, scenarios);
  if (Object.keys(body).length) {
    return call(`/${w.costingId}/versions`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: [], ...body },
    });
  }
  return prepareForCosting(w.costingId);
};
const preview = (w) => call(`/${w.costingId}/technical-preview`, { token: w.token, company: w.co._id });
const scenarioOf = (v, key) => v.cost.scenarios.find((s) => s.key === key);
const setupIn = (v, key) => scenarioOf(v, key).categorySubtotals.find((c) => c.category === "FIXED_SETUP");
const policyProvenanceFor = (v, lineKey) =>
  (v.cost.policyProvenance || []).find((p) => p.lineKey === lineKey) || null;
const offerProvenanceFor = (v, lineKey) =>
  (v.cost.offerProvenance || []).find((p) => p.lineKey === lineKey) || null;

const PATTERN = [{
  key: "pattern", label: "Pattern development", amountMinor: TEN_THOUSAND,
  currency: "INR", basis: "FIXED_PER_RUN", active: true, effectiveFrom: "2026-01-01",
}];

/* ═══ 1 · THE TWO AUTHORITATIVE PATHS ═════════════════════════════════════ */

describe("one-time setup work is priced from a real source, never typed", () => {
  test("screen making bought outside is priced from the supplier's own quotation", async () => {
    const w = await world({
      development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const line = v.cost.inputs.find((l) => l.lineKey === w.seeded.developmentLineKey);
    expect(line).toBeTruthy();
    /* A FIXED_SETUP, not a SERVICE — the difference is the whole point. */
    expect(line.category).toBe("FIXED_SETUP");
    expect(line.behaviour).toBe("FIXED_PER_RUN");
    expect(line.amount.amountMinor).toBe(TEN_THOUSAND);
    /* No rate: a fixed charge is a total for the run. */
    expect(line.unitRate).toBeUndefined();
    expect(line.confidence).toBe("SUPPLIER_QUOTATION");

    /* And the quotation behind it, frozen. */
    const prov = offerProvenanceFor(v, w.seeded.developmentLineKey);
    expect(prov.quotationReference).toMatch(/^QD-SB-/);
    expect(prov.basis).toBe("FIXED_PER_RUN");
    expect(prov.supplierName).toMatch(/^Screen Room/);
  });

  test("pattern development done in-house is priced from the company's own charge", async () => {
    /* No supplier and no quotation: the company's own pattern room did the
       work. What exists is a charge Finance published. */
    const w = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: PATTERN },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const line = v.cost.inputs.find((l) => l.lineKey === w.seeded.developmentLineKey);
    expect(line.category).toBe("FIXED_SETUP");
    expect(line.behaviour).toBe("FIXED_PER_RUN");
    expect(line.amount.amountMinor).toBe(TEN_THOUSAND);
    /* ── AUTHORITATIVE, AND NOT A QUOTATION ────────────────────────────
       It carries no supplier and no reference; labelling it
       SUPPLIER_QUOTATION would claim evidence that does not exist. The
       requirement was confirmed on the sample and the amount is Finance's,
       so both halves are authoritative and the line is VERIFIED. */
    expect(line.confidence).toBe("VERIFIED");
    expect(offerProvenanceFor(v, w.seeded.developmentLineKey)).toBeNull();

    expect(line.label).toBe("Pattern development");
    const prov = policyProvenanceFor(v, w.seeded.developmentLineKey);
    expect(prov).toMatchObject({
      state: "COMPANY_POLICY",
      chargeKey: "pattern",
      chargeLabel: "Pattern development",
      amountMinor: TEN_THOUSAND,
      currency: "INR",
      basis: "FIXED_PER_RUN",
    });
    expect(prov.policyRevision).toBeGreaterThan(0);
    expect(prov.effectiveFrom).toBeTruthy();
  });

  test("a planned requirement stays provisional however good the charge", async () => {
    /* A line is as good as its weaker half. The amount is Finance's; the
       requirement was specified for production and never demonstrated. */
    const w = await world(
      { development: { internal: true, chargeKey: "pattern", evidence: "BOM_PLANNED" } },
      { charges: PATTERN },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(v.cost.inputs.find((l) => l.lineKey === w.seeded.developmentLineKey).confidence)
      .toBe("PROVISIONAL");
    expect(v.warnings.some((x) => x.code === "PROVISIONAL_INPUTS")).toBe(true);
  });
});

/* ═══ 2 · THE ECONOMY OF SCALE THIS FAMILY EXISTS FOR ═════════════════════ */

test("₹10,000 of setup stays ₹10,000, and each garment carries ₹100, ₹20, ₹10", async () => {
  /* ── THE ERROR THIS RULES OUT ─────────────────────────────────────────
     Multiplying a one-time charge by the run would make a 1,000-piece order
     cost ₹10,00,000 in pattern work. What actually happens is that the same
     ₹10,000 is spread thinner — which is precisely the argument a customer
     makes for a bigger order, and it has to be arithmetically true. */
  const w = await world(
    { development: { internal: true, chargeKey: "pattern" } },
    { charges: PATTERN },
  );
  const r = await calc(w, THREE);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];

  /* The same money, three times. */
  for (const key of ["q100", "q500", "q1000"]) {
    expect(setupIn(v, key).totalMinor).toBe(TEN_THOUSAND);
  }
  /* And what each garment carries: ₹100, ₹20, ₹10. */
  expect(setupIn(v, "q100").perUnitMinor).toBe(10000);
  expect(setupIn(v, "q500").perUnitMinor).toBe(2000);
  expect(setupIn(v, "q1000").perUnitMinor).toBe(1000);

  /* The scenario's own fixed figures agree, so the comparison a reader makes
     between run sizes is the engine's and not their own arithmetic. */
  expect(scenarioOf(v, "q100").fixedTotalMinor).toBe(TEN_THOUSAND);
  expect(scenarioOf(v, "q1000").fixedTotalMinor).toBe(TEN_THOUSAND);
  expect(scenarioOf(v, "q100").fixedPerUnitMinor).toBe(10000);
  expect(scenarioOf(v, "q1000").fixedPerUnitMinor).toBe(1000);

  /* And the unit cost falls with it — this style has no other cost. */
  expect(scenarioOf(v, "q100").unitCostMinor).toBe(10000);
  expect(scenarioOf(v, "q1000").unitCostMinor).toBe(1000);
});

test("an externally quoted setup dilutes identically", async () => {
  const w = await world({
    development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
  });
  const r = await calc(w, THREE);
  const v = r.body.versions[0];
  for (const key of ["q100", "q500", "q1000"]) {
    expect(setupIn(v, key).totalMinor).toBe(TEN_THOUSAND);
  }
  expect(setupIn(v, "q100").perUnitMinor).toBe(10000);
  expect(setupIn(v, "q1000").perUnitMinor).toBe(1000);
});

/* ═══ 3 · WHAT IS REFUSED ═════════════════════════════════════════════════ */

describe("a setup cost with no authoritative source blocks the costing", () => {
  test("no approved catalogue names the Board, and offers no amount to type", async () => {
    /* ── THE DESK NAMED IS THE ONE THAT CAN CLOSE IT ──────────────────
       This said Finance, because the charge table was a costing-policy field.
       What the company charges for work it does itself is a price it publishes
       about its own capability — nobody quoted it and nobody measured it — so
       it is a Board decision now, and a refusal naming Finance would send
       somebody to a screen that can no longer answer.

       The message changed with it: "has not configured any" was true of a
       table anybody could fill in; what is true now is that nobody has
       approved a catalogue. */
    const w = await world({ development: { internal: true, chargeKey: "pattern" } });
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ASSEMBLY_BLOCKED");
    expect(r.body.error.details.owner.department).toBe("Board");
    expect(r.body.error.message).toMatch(/has not approved a development charge catalogue/);
    /* And it still says the work is not free, which is the point of refusing
       rather than costing it at nothing. */
    expect(r.body.error.message).toMatch(/It is not free/);
    /* Nothing was written, and nothing suggests typing a figure. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/provisional override/i);
  });

  test("a charge that exists under another key names what IS configured", async () => {
    const w = await world(
      { development: { internal: true, chargeKey: "marker" } },
      { charges: PATTERN },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No company development charge is configured under "marker"/);
    /* So somebody can see whether they meant another one, rather than being
       told only that this is wrong. */
  /* ── AND THE CANDIDATES ARE READ OFF THE ASSEMBLY, NOT OFF SALES ──────
     They used to arrive on the route's refusal. They do not arrive on Sales'
     any more, and deliberately: a candidate quotation names its supplier and
     its rate, and the narrow projection exists so that neither reaches a
     Sales response. The claim is unchanged and it is the engine's — so it is
     asserted where the data lives, and acted on by a buyer in Store. */
    const gap = (await assembleForCosting(w.costingId)).missing
      .find((m) => /No company development charge is configured/.test(m.message));
    expect(gap.candidates.map((c) => c.key)).toEqual(["pattern"]);
  });

  test("a date with no rate in force is refused, and says which date", async () => {
    /* The window closed in February and nothing replaced it. The refusal is
       about THIS costing's date rather than about the table in general —
       which is the only form of the question that has one answer. */
    const w = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: [{ ...PATTERN[0], effectiveTo: "2026-02-01" }] },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No rate for the "Pattern development" development charge was in force on \d{4}-\d{2}-\d{2}/);
  });

  test("an inactive charge is refused, and says so by name", async () => {
    const w = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: [{ ...PATTERN[0], active: false }] },
    );
    const r = await calc(w, ONE);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/"Pattern development" development charge is no longer active/);
  });

  test("an inactive service cannot supply setup work either", async () => {
    const w = await world({
      development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
    });
    await Service.updateOne({ _id: w.seeded.devServiceMaster._id }, { $set: { status: "INACTIVE" } });
    const r = await calc(w, ONE);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.versions).toBeUndefined();
  });

  test("another company's service quotation is not a candidate", async () => {
    const w = await world({
      development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
    });
    const other = await Acc_Company.create({ companyName: `Foreign ${++seq}`, booksFromDate: new Date("2026-04-01") });
    const foreignSupplier = await Vendor.create({
      companyId: other._id, companyName: "Foreign Screens", vendorType: "Supplier", status: "Active",
    });
    await ServiceSupplierOffer.create({
      companyId: other._id, supplierId: foreignSupplier._id, supplierName: foreignSupplier.companyName,
      serviceId: w.seeded.devServiceMaster._id, billingUnit: "Lot", currency: "INR",
      unitPriceMinor: 1, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18,
      quotationReference: "FOREIGN-D", status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
    });
    const r = await calc(w, ONE);
    expect(r.status).toBe(201);
    /* Priced from OURS, and the foreign one was never a choice. */
    expect(r.body.versions[0].cost.inputs.find((l) => l.lineKey === w.seeded.developmentLineKey)
      .amount.amountMinor).toBe(TEN_THOUSAND);
    expect(JSON.stringify(r.body)).not.toContain("Foreign Screens");
  });

  test("a company's own charge table is not another company's", async () => {
    /* Configured here, and invisible there — the policy is read from the
       authenticated context, never from a payload. */
    const mine = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: PATTERN },
    );
    const theirs = await world({ development: { internal: true, chargeKey: "pattern" } });
    expect((await calc(mine, ONE)).status).toBe(201);
    const blocked = await calc(theirs, ONE);
    expect(blocked.status).toBe(409);
    /* The Board's, since the catalogue became a Board policy — and still
       resolved per company, which is what this test is about. */
    expect(blocked.body.error.details.owner.department).toBe("Board");
  });
});

test("several quotations for setup work remain a decision, never settled by price", async () => {
  const w = await world({
    development: {
      internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND,
      second: { rateMinor: 500000 },
    },
  });
  const r = await calc(w, ONE);
  expect(r.status).toBe(409);
  expect(r.body.error.message).toMatch(/2 applicable quotations/);
  /* ── AND THE CANDIDATES ARE READ OFF THE ASSEMBLY, NOT OFF SALES ──────
     They used to arrive on the route's refusal. They do not arrive on Sales'
     any more, and deliberately: a candidate quotation names its supplier and
     its rate, and the narrow projection exists so that neither reaches a
     Sales response. The claim is unchanged and it is the engine's — so it is
     asserted where the data lives, and acted on by a buyer in Store. */
  const gap = (await assembleForCosting(w.costingId)).missing
    .find((m) => /applicable quotations/.test(m.message));
  const candidates = gap.candidates;
  expect(candidates).toHaveLength(2);
  /* Supplier order, never price order — the cheaper one is not preferred. */
  expect(candidates.map((c) => c.supplierName.slice(0, 13)))
    .toEqual(["Screen Room 1", "Screen Room B"].map((x) => x.slice(0, 13)));
  expect(candidates.some((c) => c.selected)).toBe(false);
  expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(1);

  /* ── AND NAMING ONE IS STORE'S ACT, NOT THE CALCULATION'S ────────────
     This posted `quotationChoices` and asserted the chosen charge was used.
     Development work bought outside is sourced like any other outside job, so
     the decision moved with the rest: Store records it against the
     requirement and the costing reads it. The positive claim — a named
     quotation is honoured and re-read — is proved on that path in
     `sourcing-decisions.route.test.js`, including for DEVELOPMENT.

     What this asserts is the half that belongs here: the calculation will not
     take the decision from a request. */
  const chosen = await calc(w, ONE, {
    quotationChoices: { [w.seeded.developmentLineKey]: String(w.seeded.devServiceOffer._id) },
  });
  /* Refused at the door — the route reads no body at all now. The parser's
     own refusal, which names Store, is asserted directly so the rule keeps a
     test even with no route that can carry a choice to it. */
  expect(chosen.status).toBe(409);
  expect(chosen.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

  const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
  let told = null;
  try {
    refuseQuotationChoices({
      quotationChoices: { [w.seeded.developmentLineKey]: String(w.seeded.devServiceOffer._id) },
    });
  } catch (err) { told = err; }
  expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
  expect(told.details.owner.department).toBe("Store");
});

test("one requirement cannot be costed from both sources at once", async () => {
  /* ── TWO ANSWERS IS ONE TOO MANY ──────────────────────────────────────
     A requirement naming a supplier's service AND a company charge would
     have two prices and nothing choosing between them. `developmentSource`
     is single-valued and the assembly reads exactly one path from it: an
     internal row is never offered a quotation, and an external row never
     reads the charge table. */
  const w = await world(
    { development: { internal: true, chargeKey: "pattern" } },
    { charges: PATTERN },
  );
  /* Force both onto the stored row, as a stale or crafted client might. */
  await SampleStyle.updateOne({ _id: w.seeded.style._id }, {
    $set: { "sample.serviceRequirements.0.serviceId": new mongoose.Types.ObjectId() },
  });
  const r = await calc(w, ONE);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];
  /* Priced ONCE, from the policy the row declared. The stray service id is
     not read, and no second line appeared. */
  expect(v.cost.inputs.filter((l) => l.category === "FIXED_SETUP")).toHaveLength(1);
  expect(policyProvenanceFor(v, w.seeded.developmentLineKey).chargeKey).toBe("pattern");
  expect(offerProvenanceFor(v, w.seeded.developmentLineKey)).toBeNull();
});

/* ═══ 4 · FROZEN, AND UNMOVED BY LATER CHANGES ════════════════════════════ */

test("a later charge revision does not re-price an existing version", async () => {
  /* The whole claim of an effective-dated table: Finance publishing next
     quarter's pattern charge must not silently re-price a costing already
     approved against this quarter's. */
  const w = await world(
    { development: { internal: true, chargeKey: "pattern" } },
    { charges: PATTERN },
  );
  const r = await calc(w, THREE);
  expect(r.status).toBe(201);
  const before = r.body.versions[0];
  const versionId = before.id;

  /* A NEW approved catalogue, in force from today — which is how the Board
     changes a charge. The earlier version stays exactly as it was approved. */
  await approveDevelopmentPolicy(
    w.co._id,
    [{ ...PATTERN[0], amountMinor: 5000000, label: "Pattern development (revised)" }],
    { effectiveFrom: new Date() },
  );

  const reread = await call(`/${w.costingId}/versions`, { token: w.token, company: w.co._id });
  const after = reread.body.versions.find((x) => x.id === versionId);
  expect(setupIn(after, "q100").totalMinor).toBe(TEN_THOUSAND);
  expect(scenarioOf(after, "q1000").unitCostMinor).toBe(scenarioOf(before, "q1000").unitCostMinor);
  /* And the frozen provenance still names what it actually used. */
  expect(policyProvenanceFor(after, w.seeded.developmentLineKey).amountMinor).toBe(TEN_THOUSAND);
  expect(policyProvenanceFor(after, w.seeded.developmentLineKey).chargeLabel).toBe("Pattern development");
});

test("and a quotation withdrawn afterwards does not re-price one either", async () => {
  const w = await world({
    development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
  });
  const r = await calc(w, THREE);
  expect(r.status).toBe(201);
  const versionId = r.body.versions[0].id;

  /* The supplier withdraws it — through the register's own lifecycle, which
     is the only way it moves. A frozen version is what was decided on the
     day, against the quotation that was live then. */
  const doc = await ServiceSupplierOffer.findById(w.seeded.devServiceOffer._id);
  doc.status = "WITHDRAWN";
  doc.withdrawalReason = "The screen room closed.";
  await ServiceSupplierOffer.beginServiceOfferLifecycle(doc, "WITHDRAW").save();

  const reread = await call(`/${w.costingId}/versions`, { token: w.token, company: w.co._id });
  const after = reread.body.versions.find((x) => x.id === versionId);
  expect(setupIn(after, "q100").totalMinor).toBe(TEN_THOUSAND);
  expect(offerProvenanceFor(after, w.seeded.developmentLineKey).quotationReference).toMatch(/^QD-SB-/);

  /* And the NEXT costing is refused rather than quietly using it again. */
  const next = await calc(w, THREE);
  expect(next.status).toBeGreaterThanOrEqual(400);
});

/* ═══ 5 · WHAT THE SCREEN IS GIVEN ════════════════════════════════════════ */

describe("the preview shows a source-driven group, not a box to type in", () => {
  test("development is its own group, with its source, total and owner", async () => {
    const w = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: PATTERN },
    );
    const p = await preview(w);
    expect(p.status).toBe(200);
    const rows = p.body.assembly.rows.development;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "COMPANY_POLICY",
      sourceLabel: "Company development charge",
      chargeKey: "pattern",
      chargeLabel: "Pattern development",
      /* Named by the charge Finance published, not by the key it is stored
         under — "pattern" on a cost line is a database value on a page a
         person is meant to read. */
      description: "Pattern development",
      basis: "FIXED_PER_RUN",
      basisLabel: "for the run",
      owner: "Finance",
      fixedTotalMinor: TEN_THOUSAND,
      state: "VERIFIED",
    });
    /* Not folded into outside services — the two are the opposite kind of
       cost, and a reader who cannot tell them apart cannot check either. */
    expect(p.body.assembly.rows.services).toHaveLength(0);
  });

  test("externally quoted setup shows the supplier it is priced from", async () => {
    const w = await world({
      development: { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND },
    });
    const p = await preview(w);
    const row = p.body.assembly.rows.development[0];
    expect(row.sourceType).toBe("SUPPLIER_QUOTATION");
    expect(row.sourceLabel).toBe("Supplier quotation");
    expect(row.owner).toBe("R&D");
    /* ── THE FIGURE ON SCREEN IS THE ONE THAT WILL BE FROZEN ──────────
       One applicable quotation is not a question, so it is attached and the
       row reads as sourced — not as a gap that the save then fills in
       silently with a real number. */
    expect(row.quotation).toMatchObject({ offerId: String(w.seeded.devServiceOffer._id), state: "SELECTED" });
    expect(row.state).toBe("VERIFIED");
    expect(p.body.assembly.quotationDecisions.some((d) => d.lineKey === row.lineKey)).toBe(false);
  });

  test("two quotations reach the screen as a decision owned by Store", async () => {
    const w = await world({
      development: {
        internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_THOUSAND,
        second: { rateMinor: 500000 },
      },
    });
    const p = await preview(w);
    const row = p.body.assembly.rows.development[0];
    expect(row.state).toBe("MISSING");
    expect(row.quotation).toBeNull();
    const decision = p.body.assembly.quotationDecisions.find((d) => d.lineKey === row.lineKey);
    expect(decision).toBeTruthy();
    expect(decision.owner.department).toMatch(/Store/);
    expect(decision.candidates).toHaveLength(2);
    /* Offered, not ranked — the screen asks rather than proposing the
       cheaper one. */
    expect(decision.candidates.some((c) => c.selected)).toBe(false);
  });

  test("the family no longer reads as one with no source", async () => {
    const w = await world(
      { development: { internal: true, chargeKey: "pattern" } },
      { charges: PATTERN },
    );
    const p = await preview(w);
    const families = Object.fromEntries(p.body.assembly.coverage.families.map((f) => [f.key, f]));
    expect(families.development.authority).toBe("AUTOMATIC");
    /* And the message no longer sends anybody to type a figure. */
    expect(families.development.awaitingMessage).not.toMatch(/override/i);

    /* Freight has one now too, and so does customs duty — Store's sourcing
       evidence read against the Board's approved tariff table. The point of
       this assertion survives: a family with a source must not keep reading
       like one with none. */
    expect(families.freight.authority).toBe("AUTOMATIC");
    expect(families.duty.authority).toBe("AUTOMATIC");
  });
});

/* ═══ 6 · AND RECURRING WORK IS UNCHANGED ═════════════════════════════════ */

test("an outside process still scales with the run, as a SERVICE", async () => {
  /* The same Service master answers both, so the one thing that must not
     happen is a wash being diluted or a screen charge being multiplied. */
  const w = await world({
    service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
  });
  const r = await calc(w, THREE);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];
  const svc = (k) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === "SERVICE");
  expect(svc("q100").perUnitMinor).toBe(800);
  expect(svc("q1000").perUnitMinor).toBe(800);
  expect(svc("q100").totalMinor).toBe(80000);
  expect(svc("q1000").totalMinor).toBe(800000);
  /* And no setup line was invented for a style that records none. */
  expect(v.cost.inputs.some((l) => l.category === "FIXED_SETUP")).toBe(false);
});

test("a style with both keeps them apart", async () => {
  const w = await world(
    {
      service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
      development: { internal: true, chargeKey: "pattern" },
    },
    { charges: PATTERN },
  );
  const r = await calc(w, THREE);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];
  const at = (k, cat) => scenarioOf(v, k).categorySubtotals.find((c) => c.category === cat);
  /* The wash scales; the pattern charge dilutes. */
  expect(at("q100", "SERVICE").perUnitMinor).toBe(800);
  expect(at("q1000", "SERVICE").perUnitMinor).toBe(800);
  expect(at("q100", "FIXED_SETUP").perUnitMinor).toBe(10000);
  expect(at("q1000", "FIXED_SETUP").perUnitMinor).toBe(1000);
});

/* ═══ 7 · AND NOWHERE IS AN AMOUNT TYPED ══════════════════════════════════ */

test("no costing path accepts a typed setup amount as the normal answer", async () => {
  /* The family's whole point. A hand-entered figure is still possible as a
     DECLARED override — that is what an override is for, and it is refused
     without a family and a reason — but it is no longer what the screen or
     the coverage message asks for. */
  const w = await world(
    { development: { internal: true, chargeKey: "pattern" } },
    { charges: PATTERN },
  );
  /* ── AND THE DOOR IT WOULD HAVE COME THROUGH IS SHUT ──────────────────
     This posted a typed setup line and read `COSTING_MANUAL_LINE_REFUSED`.
     The rule still stands on the engine — a hand-entered figure is refused
     wherever it arrives — but the route that carried it now refuses a browser
     client outright, before it looks at the body. Both refusals say the same
     thing about what this app will accept; the second says it earlier. */
  const typed = await calc(w, ONE, {
    lines: [{
      lineKey: "typed-setup", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN",
      label: "Pattern", amount: { amountMinor: 999999, currency: "INR" },
    }],
  });
  expect(typed.status).toBe(409);
  expect(typed.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
});
