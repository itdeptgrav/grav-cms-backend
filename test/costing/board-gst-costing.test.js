// test/costing/board-gst-costing.test.js
//
// THE BOARD'S INPUT GST TREATMENT, MEETING A REAL COSTING.
//
// ── WHAT THIS MIGRATION MUST NOT HAVE CHANGED ───────────────────────────────
// The arithmetic, and the quotation's own precedence. `offerPricing
// .taxPositionFor` remains the single place a tax position is decided: it
// refuses `NONE` as the absence of an opinion, refuses a company treatment on
// a `NON_TAXABLE` quotation, and refuses a taxable quotation with no recorded
// rate rather than calling it zero-rated. None of that was touched.
//
// ── AND WHAT IT DID CHANGE ──────────────────────────────────────────────────
// Where the treatment comes from, and what the version can say about WHO
// decided it. One overlay reaches every family — materials, packaging,
// outside services, bought-in development and freight — because all five are
// handed `policy.inputGstTreatment` from one object.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const policyService = require("../../services/centralCosting/policy.service");
const {
  seedSourceBacked, configureProduction, approveGstPolicy, EVERY_FAMILY, EXPECTED, prepareForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
  await BoardPolicy.init();
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `gst-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function admin(companies = []) {
  const n = ++seq;
  const email = `gc-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "G", lastName: `C${n}`, email, biometricId: `GC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "G", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "G" });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "G Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* No overhead, no financing: both would sit on top of every figure asserted
   here, and each is proved in its own suite. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const SCEN = [{ key: "q500", quantity: "500", isPrimary: true }];

async function world({ gst = {}, seed = {} } = {}) {
  const co = await company("Gst");
  const me = await admin([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  const seeded = await seedSourceBacked(co._id, seed);
  await configureProduction(co._id, { overhead: null, gst });
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was Calculate, and it refuses a browser client now
   (`COSTING_PREPARATION_MOVED_TO_SALES`). What this suite proves — which
   Board policy is applied to which basis, and what the version freezes — is
   about the ENGINE, and the engine is unchanged: the orchestration resolves
   the brief and the effective policies and calls it. Only the door moved. */
const calc = (w) => prepareForCosting(w.costingId);

const scen = (r) => r.body.versions[0].cost.scenarios[0];
/* The scenario's RESULT for a line: what it came to at this quantity. Its
   `taxMinor` is the tax ADDED TO COST — zero when the tax is recoverable,
   because the engine reports that separately on `recoverableTaxMinor` rather
   than adding it. */
const lineOf = (r, prefix) => scen(r).lines.find((l) => l.lineKey.startsWith(prefix));
/* The frozen INPUT line: where the tax position itself lives. */
const inputOf = (r, prefix) => (r.body.versions[0].cost.inputs || [])
  .find((l) => l.lineKey.startsWith(prefix));

/* ═══ 1 · RECOVERABLE VERSUS NON-RECOVERABLE ══════════════════════════════ */

describe("the two answers, and the whole tax amount between them", () => {
  test("recoverable reports the tax and adds nothing to cost", async () => {
    const w = await world({ gst: { inputGstTreatment: "RECOVERABLE" } });
    const r = await calc(w);
    expect(r.status).toBe(201);

    expect(inputOf(r, "mat:").tax).toEqual({ treatment: "RECOVERABLE", ratePercent: "12" });

    /* ── REPORTED, NEVER ADDED ─────────────────────────────────────────
       12% of 50,00,000 is 6,00,000 of tax. The company reclaims it, so the
       line adds none of it to cost and the scenario reports it on its own. */
    const material = lineOf(r, "mat:");
    expect(material.totalMinor).toBe(EXPECTED.materialRateMinor * 500);
    expect(material.taxMinor).toBe(0);
    expect(scen(r).recoverableTaxMinor).toBe(600000);
    expect(scen(r).unitCostMinor).toBe(EXPECTED.materialRateMinor + EXPECTED.labourRateMinor);
  });

  test("non-recoverable adds it to the line, and reclaims nothing", async () => {
    const w = await world({ gst: { inputGstTreatment: "NON_RECOVERABLE" } });
    const r = await calc(w);
    expect(inputOf(r, "mat:").tax).toEqual({ treatment: "NON_RECOVERABLE", ratePercent: "12" });

    /* The fixture quotes 12% on 100.00 a metre, 1 metre a garment, 500
       garments: 50,00,000 base + 6,00,000 tax, all of it cost. */
    const material = lineOf(r, "mat:");
    expect(material.taxMinor).toBe(600000);
    expect(material.totalMinor).toBe(EXPECTED.materialRateMinor * 500 + 600000);
    expect(scen(r).recoverableTaxMinor).toBe(0);
    /* And the garment carries it: 1,200 paise a piece more. */
    expect(scen(r).unitCostMinor)
      .toBe(EXPECTED.materialRateMinor + EXPECTED.labourRateMinor + 1200);
  });

  test("the difference between the two answers is the tax, to the paisa", async () => {
    const rec = await calc(await world({ gst: { inputGstTreatment: "RECOVERABLE" } }));
    const non = await calc(await world({ gst: { inputGstTreatment: "NON_RECOVERABLE" } }));
    const recMat = lineOf(rec, "mat:");
    const nonMat = lineOf(non, "mat:");
    /* The same tax, on the same base, landing in two different places. */
    expect(scen(rec).recoverableTaxMinor).toBe(600000);
    expect(nonMat.taxMinor).toBe(600000);
    expect(nonMat.totalMinor - recMat.totalMinor).toBe(600000);
    expect(scen(non).recoverableTaxMinor).toBe(0);
    expect(recMat.taxMinor).toBe(0);
  });
});

/* ═══ 2 · MISSING IS MISSING ══════════════════════════════════════════════ */

describe("a company whose Board has not decided", () => {
  test("a quotation-backed line is refused, never priced on an assumption", async () => {
    /* ── THE ASSUMPTION THAT WOULD BE INVISIBLE ────────────────────────
       Recoverable is the common answer, so it is the one a default would
       pick — and it under-costs every non-recoverable purchase. */
    const w = await world({ gst: null });
    const r = await calc(w);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/TAX_TREATMENT_REQUIRED|recoverable/i);
  });

  test("a draft nobody approved is not a policy", async () => {
    const w = await world({ gst: null });
    const boardPolicy = require("../../services/board/boardPolicy.service");
    await boardPolicy.createDraft(
      { companyId: w.co._id, actorId: "x", actorName: "X" },
      { policyKey: "GST_TAX_POLICY", gst: { inputGstTreatment: "RECOVERABLE" } },
    );
    expect((await calc(w)).status).toBe(400);
  });

  test("a future-dated policy does not reach a costing made today", async () => {
    const w = await world({ gst: null });
    await approveGstPolicy(w.co._id, { effectiveFrom: new Date("2035-01-01") });
    expect((await calc(w)).status).toBe(400);
  });

  test("a domestic-sourcing decision cannot stand in for a missing treatment", async () => {
    /* ── DUTY AND GST ARE NOT ONE ANSWER ───────────────────────────────
       "Every material is bought in India, so there is no customs entry" says
       nothing about whether input GST is reclaimed, and must not close the
       family on its own. */
    const familyApplicability = require("../../services/centralCosting/familyApplicability.service");
    const w = await world({ gst: null });
    const decision = await familyApplicability.dutyDecision(
      { companyId: w.co._id },
      { itemIds: [String(w.seeded.item?._id || new mongoose.Types.ObjectId())], policySnapshot: {} },
    );
    expect(decision).toBeNull();
  });
});

/* ═══ 3 · THE QUOTATION STILL WINS WHERE IT SAYS SO ═══════════════════════ */

describe("quotation-specific tax facts keep precedence", () => {
  const offerPricing = require("../../services/centralCosting/offerPricing.service");

  test("a non-taxable quotation carries no GST, whatever the policy says", () => {
    const pos = offerPricing.taxPositionFor(
      { offerId: "o1", priceBasis: "NON_TAXABLE", gstRatePercent: undefined }, "NONE",
    );
    expect(pos).toEqual({ treatment: "NONE", ratePercent: "0" });
  });

  test("a company treatment is refused on a non-taxable quotation, not applied", () => {
    /* The Board decides how ELIGIBLE input tax is treated. It does not decide
       what is taxable. */
    expect(() => offerPricing.taxPositionFor(
      { offerId: "o1", priceBasis: "NON_TAXABLE", gstRatePercent: undefined }, "RECOVERABLE",
    )).toThrow();
  });

  test("a taxable quotation with no recorded rate is refused, not zero-rated", () => {
    expect(() => offerPricing.taxPositionFor(
      { offerId: "o2", priceBasis: "PER_UNIT", gstRatePercent: undefined }, "RECOVERABLE",
    )).toThrow(/records no GST rate/);
  });

  test("an explicit zero rate is a supplier's statement, and is honoured", () => {
    /* `undefined` is "nobody wrote a rate down"; `0` is "this is zero-rated". */
    const pos = offerPricing.taxPositionFor(
      { offerId: "o3", priceBasis: "PER_UNIT", gstRatePercent: 0 }, "RECOVERABLE",
    );
    expect(pos).toEqual({ treatment: "RECOVERABLE", ratePercent: "0" });
  });

  test("a decimal rate is carried exactly, not rounded to a whole percent", () => {
    const pos = offerPricing.taxPositionFor(
      { offerId: "o4", priceBasis: "PER_UNIT", gstRatePercent: 12.5 }, "NON_RECOVERABLE",
    );
    expect(pos.ratePercent).toBe("12.5");
  });

  test("`NONE` from the company is refused — the absence of an opinion", () => {
    expect(() => offerPricing.taxPositionFor(
      { offerId: "o5", priceBasis: "PER_UNIT", gstRatePercent: 18 }, "NONE",
    )).toThrow();
  });
});

/* ═══ 4 · EVERY FAMILY, ONE POLICY ════════════════════════════════════════ */

describe("one treatment reaches every purchased family", () => {
  test("materials, packaging, outside services and bought-in development all carry it", async () => {
    const w = await world({
      gst: { inputGstTreatment: "NON_RECOVERABLE" },
      seed: { ...EVERY_FAMILY },
    });
    const r = await calc(w);
    expect(r.status).toBe(201);

    /* Every quotation-backed line states the same company treatment, from one
       overlay — materials and packaging through `attachQuotations`, outside
       processes and bought-in development through `attachServiceQuotations`. */
    const taxed = (r.body.versions[0].cost.inputs || [])
      .filter((l) => l.tax && l.tax.treatment !== "NONE");
    expect(taxed.length).toBeGreaterThanOrEqual(3);
    for (const l of taxed) {
      expect(l.tax.treatment).toBe("NON_RECOVERABLE");
      expect(l.tax.ratePercent).toBeTruthy();
    }
    /* Materials, packaging and at least one bought-in service among them. */
    const prefixes = taxed.map((l) => l.lineKey.split(":")[0]);
    expect(new Set(prefixes).size).toBeGreaterThanOrEqual(3);
    /* And each names the quotation its rate came from. */
    const offers = r.body.versions[0].cost.offerProvenance || [];
    for (const p of offers) {
      if (p.taxTreatment && p.taxTreatment !== "NONE") {
        expect(p.taxTreatment).toBe("NON_RECOVERABLE");
        expect(p.gstRatePercent).not.toBeNull();
      }
    }
  });

  test("an ex-works order's freight is a recorded zero and carries no tax", async () => {
    /* Freight goes through the same `taxPositionFor`; where the company bears
       none, there is no taxable supply to treat. */
    const w = await world({ gst: {}, seed: { ...EVERY_FAMILY } });
    const r = await calc(w);
    const freight = scen(r).lines.find((l) => l.lineKey === "freight:outbound");
    expect(freight.totalMinor).toBe(0);
    expect(freight.tax?.treatment ?? "NONE").toBe("NONE");
  });
});

/* ═══ 5 · WHAT IS FROZEN ══════════════════════════════════════════════════ */

describe("a frozen version explains the tax and who decided it", () => {
  test("the Board decision, and the per-line workings that were already frozen", async () => {
    const w = await world({ gst: { inputGstTreatment: "RECOVERABLE" } });
    const r = await calc(w);

    /* The new half: which decision produced the treatment. */
    const gp = r.body.versions[0].cost.gstProvenance;
    expect(gp.boardPolicyId).toBeTruthy();
    expect(gp.policyKey).toBe("GST_TAX_POLICY");
    expect(gp.inputGstTreatment).toBe("RECOVERABLE");
    expect(gp.policyEffectiveFrom).toBeTruthy();
    expect(gp.policyApprovedAt).toBeTruthy();
    expect(gp.policyApprovedByName).toBe("Board Fixture");

    /* The half that was already there, and stays: base, rate, amount,
       treatment and the quotation it came from. */
    const material = lineOf(r, "mat:");
    const input = inputOf(r, "mat:");
    /* Quoted base amount, GST rate, whether it was cost, and the tax figure
       itself — all four already frozen, and staying where they are. */
    expect(input.unitRate.amountMinor).toBe(EXPECTED.materialRateMinor);
    expect(input.tax.ratePercent).toBe("12");
    expect(input.tax.treatment).toBe("RECOVERABLE");
    expect(scen(r).recoverableTaxMinor).toBe(600000);
    expect(material.taxMinor).toBe(0);
    const prov = (r.body.versions[0].cost.offerProvenance || [])
      .find((p) => p.lineKey === material.lineKey);
    expect(prov.offerId).toBeTruthy();
    expect(prov.gstRatePercent).not.toBeNull();
  });

  test("a new Board policy does not restate a version frozen before it", async () => {
    const w = await world({ gst: { inputGstTreatment: "RECOVERABLE" } });
    const before = await calc(w);
    const frozen = lineOf(before, "mat:").totalMinor;

    await approveGstPolicy(w.co._id, {
      inputGstTreatment: "NON_RECOVERABLE", effectiveFrom: new Date(Date.now() - 1000),
    });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey.startsWith("mat:")).totalMinor).toBe(frozen);
    expect(v.cost.gstProvenance.inputGstTreatment).toBe("RECOVERABLE");

    const stored = await CostingVersion.findById(v.id).lean();
    expect(stored.gstProvenance.inputGstTreatment).toBe("RECOVERABLE");
    expect(stored.policySnapshot.inputGstTreatment).toBe("RECOVERABLE");
  });

  test("a backdated approval cannot restate it either", async () => {
    const w = await world({ gst: { inputGstTreatment: "RECOVERABLE" } });
    const before = await calc(w);
    await approveGstPolicy(w.co._id, {
      inputGstTreatment: "NON_RECOVERABLE", effectiveFrom: new Date("2020-01-01"),
    });
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.gstProvenance.inputGstTreatment).toBe("RECOVERABLE");
  });

  test("each date resolves to the treatment in force on it", async () => {
    const w = await world({ gst: null });
    await approveGstPolicy(w.co._id, {
      inputGstTreatment: "NON_RECOVERABLE", effectiveFrom: new Date("2026-01-01"),
    });
    await approveGstPolicy(w.co._id, {
      inputGstTreatment: "RECOVERABLE", effectiveFrom: new Date("2026-07-01"),
    });
    const march = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-03-01") });
    expect(march.policy.inputGstTreatment).toBe("NON_RECOVERABLE");
    const sept = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-09-01") });
    expect(sept.policy.inputGstTreatment).toBe("RECOVERABLE");
  });
});

/* ═══ 6 · THE LEGACY WRITER ═══════════════════════════════════════════════ */

describe("the costing policy is no longer a way to set the treatment", () => {
  const putPolicy = (me, co, body) =>
    call("/policy/current", { method: "PUT", token: me.token, company: co._id, body });

  test("setting a treatment is refused by name", async () => {
    const co = await company("Moved");
    const me = await admin([co]);
    for (const t of ["RECOVERABLE", "NON_RECOVERABLE"]) {
      const r = await putPolicy(me, co, { ...POLICY, inputGstTreatment: t });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("GST_POLICY_MOVED");
      expect(r.body.error.details.field).toBe("inputGstTreatment");
      expect(r.body.error.details.ownedBy).toBe("BOARD");
    }
    expect(await CostingPolicy.findOne({ companyId: co._id }).lean()).toBeNull();
  });

  test("a legacy value is readable, marked uneditable, and applied to nothing", async () => {
    const co = await company("Legacy");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id }, { $set: { inputGstTreatment: "NON_RECOVERABLE" } },
    );

    const back = await call("/policy/current", { token: me.token, company: co._id });
    expect(back.body.policy.inputGstTreatment).toBe("NON_RECOVERABLE");
    expect(back.body.policy.gstPolicy.editable).toBe(false);
    expect(back.body.policy.gstPolicy.legacyValuePresent).toBe(true);
    expect(back.body.policy.gstPolicy.boardPolicyInForce).toBe(false);

    const resolved = await policyService.getPolicy({ companyId: co._id }, {});
    expect(resolved.policy.inputGstTreatment).toBeUndefined();
    expect(resolved.policy.legacyInputGstTreatment).toBe("NON_RECOVERABLE");
  });

  test("clearing is accepted, and only clearing", async () => {
    const co = await company("Clear");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id }, { $set: { inputGstTreatment: "RECOVERABLE" } },
    );
    const back = await call("/policy/current", { token: me.token, company: co._id });
    const cleared = await putPolicy(me, co, {
      ...POLICY, revision: back.body.revision, inputGstTreatment: null,
    });
    expect(cleared.status).toBe(200);
    expect((await CostingPolicy.findOne({ companyId: co._id }).lean()).inputGstTreatment)
      .toBeUndefined();
  });

  test("a save of an unrelated field does not wipe a retained legacy value", async () => {
    const co = await company("Preserve");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id }, { $set: { inputGstTreatment: "NON_RECOVERABLE" } },
    );
    const back = await call("/policy/current", { token: me.token, company: co._id });
    const saved = await putPolicy(me, co, {
      /* A field the costing policy STILL owns: the margin band moved to the
         Board on the same terms as the rule this suite is about, so using it
         here would test a refusal rather than a retained value. */
      ...POLICY, revision: back.body.revision, sellingPriceIncrementMinor: 500,
    });
    expect(saved.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: co._id }).lean();
    expect(doc.inputGstTreatment).toBe("NON_RECOVERABLE");
    expect(doc.sellingPriceIncrementMinor).toBe(500);
  });

  test("a historical version keeps its own snapshot meaning", async () => {
    const w = await world({ gst: { inputGstTreatment: "RECOVERABLE" } });
    const r = await calc(w);
    const id = r.body.versions[0].id;
    await CostingVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(id)) }, { $unset: { gstProvenance: "" } },
    );
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === id);
    expect(v.cost.gstProvenance).toBeUndefined();
    /* Readable, and not re-presented as a Board decision. */
    expect((await CostingVersion.findById(id).lean()).policySnapshot.inputGstTreatment)
      .toBe("RECOVERABLE");
  });
});
