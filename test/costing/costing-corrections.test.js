// test/costing/costing-corrections.test.js
//
// Central Costing — Chunk 2 correction pass.
//
// Six guarantees that surrounded a correct calculator and were not themselves
// safe. Each block below pins one of them, and each names the behaviour it
// replaces: a test that only asserts the new answer leaves the next reader
// with no idea what the old one was or why it mattered.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, approveMarginPolicy, prepareForCosting } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const { BASIS_KEYS } = require("../../services/centralCosting/engine");

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

const newKey = () => `fix-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return {
      status: r.status, body: parsed,
      replayed: r.headers.get("Idempotency-Replayed"),
      recovered: r.headers.get("Idempotency-Recovered"),
    };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function admin(companies = []) {
  const n = ++seq;
  const email = `fix-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `FX${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "A", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
};
const policyBody = (revision = 0, over = {}) => ({ ...POLICY, ...over, revision });

/* ── THE MATERIAL COMES OFF THE SOURCES; THE SETUP CHARGE HAS NONE ────────
 * The shell fabric used to be typed here at ₹412.50 a metre. It is assembled
 * now — the technical record says a metre a garment, the supplier quotation
 * says the rate — so the test posts nothing for it.
 *
 * A pattern-and-marker charge was the last thing typed here, as a declared
 * override — "no authoritative record anywhere in this repository", which was
 * true when this was written. It has one now: R&D records the setup work on
 * the style and a supplier quotes it, so the seed states both and the server
 * assembles the FIXED_PER_RUN row this suite needs for the fixed-cost half of
 * the percentage-basis tests.
 *
 * Nothing is posted. `LINES` is the empty list, kept as a name because every
 * call below reads it and a literal `[]` at each site would hide the fact
 * that this suite deliberately sends no lines at all. */
const LINES = [];
const SCENARIOS = [{ key: "q500", quantity: "500", isPrimary: true }];

/* Saving the policy also states the company's production assumptions — a
   labour rate and a quotation-backed material cannot be costed without them,
   and every company in this suite is meant to be fully configured once its
   policy exists. */
const savePolicy = async (me, co, body, { overhead = {}, margin = {} } = {}) => {
  const r = await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body });
  /* Overhead is a Board policy now and the legacy body refuses it, so the
     fixture approves one. `overhead` overrides the default 12% of
     DIRECT_PLUS_FIXED for a suite that states its own arithmetic.

     `margin` does the same for the band: a suite proving what a NIL band does
     has to be able to approve one, and the default 18/25/32 would silently
     stand in for it. */
  if (r.status === 200) await configureProduction(co._id, { overhead, margin });
  return r;
};

/* ── IT USED TO BE `{ context: { type: "ADHOC" } }` ──────────────────────
   Two lines, no fixtures, and a version built from whatever the test posted.
   The fixture seeds the enquiry product, technical record, supplier quotation
   and style that a real costing stands on; nothing else in this suite
   changes. */
const newCosting = async (me, co, product = null, seedOver = {}, quantities = SCENARIOS) => {
  const seeded = await seedSourceBacked(co._id, { brief: { quantities, quantityUom: "Pieces" },
    /* The development work whose one-time charge the percentage-basis tests
       need — bought outside, so a supplier's own quotation prices it. */
    development: { internal: false, unit: "Lot", quantity: 1, rateMinor: 2500000 },
    ...(product ? { product } : {}), ...seedOver,
  });
  const r = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(r.status).toBe(201);
  return r.body.costing.id;
};

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was Calculate and refuses a browser client now. What
   this suite proves — that an unconfigured company cannot produce a priced
   version, how the percentage bases chain, that a frozen version is never
   rewritten — is the ENGINE's, and the engine is unchanged.

   A body carrying an actual LINE is a payload-contract test and still goes to
   the retired door, whose refusal is the contract now. */
const payloadContract = (body = {}) => Object.keys(body).some((k) => k !== "lines")
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calculate = (me, co, id, key = newKey(), body = { lines: LINES }) => (
  payloadContract(body)
    ? call(`/${id}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body })
    : prepareForCosting(id, { actionKey: key }));

/* ═══ 1 · A MISSING POLICY IS NOT A 0% MARGIN ════════════════════════════ */

describe("an unconfigured company cannot produce a priced version", () => {
  test("calculating is refused, and nothing at all is written", async () => {
    const co = await company("NoPolicy");
    const me = await admin([co]);
    const id = await newCosting(me, co);
    const key = newKey();

    /* WAS: the defaults (0/0/0) were treated as a policy, so this produced a
       frozen, immutable, quotable version whose recommended selling price
       equalled its cost — the absence of a decision rendered as one. */
    const r = await calculate(me, co, id, key);
    /* ── SAID EARLIER, AND BY THE DESK THAT OWNS IT ────────────────────
       `POST /:id/versions` reached the engine and refused with
       `COSTING_POLICY_REQUIRED` and a settings path. The estimate never gets
       that far now: an unconfigured company is a BLOCKING INPUT, reported by
       the assembly with the department that records it — which is what Sales
       sees as "Awaiting inputs · Finance", beside every other outstanding
       input rather than as a lone failure at the end.

       The claim is unchanged and is the one below it: nothing is written. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ASSEMBLY_BLOCKED");
    expect(r.body.error.message).toBe("Company costing policy is not configured.");
    expect(r.body.error.details.key).toBe("policy");
    expect(r.body.error.details.owner.department).toBe("Finance");

    /* No version, and the parent pointer is untouched. */
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(1); // the empty draft only
    const parent = await Costing.findById(id).lean();
    expect(parent.currentVersionNumber).toBe(1);

    /* And the idempotency action was NOT consumed: the same key works once the
       policy exists, rather than being burnt by a refusal. */
    await savePolicy(me, co, policyBody(0));
    /* And the action key was NOT consumed: the same key works once the policy
       exists, rather than being burnt by a refusal. A blocked prepare writes
       nothing at all — no version, no claim, no bookkeeping — so there is
       nothing for a later ask to replay. */
    const retry = await calculate(me, co, id, key);
    expect(retry.status).toBe(201);
    expect(retry.body.versions[0].versionNumber).toBe(2);
  });

  test("a legacy import is refused on the same rule", async () => {
    const co = await company("NoPolicyImport");
    const me = await admin([]); // single-company deployment
    const enq = await Enquiry.create({
      enquiryId: `ENQ-${++seq}`,
      journeyId: new mongoose.Types.ObjectId(),
      accountId: new mongoose.Types.ObjectId(),
      title: "Uniforms", products: [{ product: "Blazer" }], isActive: true,
      costingSheets: [{ productName: "Blazer", part: "raw",
        materials: [{ item: "Cotton", unitCost: "412.50", consumption: "1.4", unit: "m" }] }],
    });
    const made = await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Blazer" } },
    });
    const id = made.body.costing.id;

    const r = await call(`/${id}/versions/legacy-import`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      /* The legacy import states its own run sizes — it builds a version from
         a historical Sales sheet, which predates costing briefs entirely. */
      body: { scenarios: [{ key: "q500", quantity: "500", isPrimary: true }] },
    });
    if (r.body.error.code !== "COSTING_POLICY_REQUIRED") console.log("POLPROBE", JSON.stringify(r.body.error).slice(0,400));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_POLICY_REQUIRED");
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(1);
  });

  test("a policy explicitly saved at 0% margins is valid and still calculates", async () => {
    /* The distinction the whole correction turns on: "nobody has decided" and
       "we have decided to quote at cost" are different states, and only the
       first is refused. */
    const co = await company("ZeroMargin");
    const me = await admin([co]);
    /* `overhead: null` — this company's Board has approved nothing, which is
       what makes the arithmetic below the fabric and the labour and nothing
       else. The nulls on the body are the legacy CLEAR, which is still the
       one overhead write this endpoint accepts. */
    const saved = await savePolicy(me, co, policyBody(0, {
      overheadBasis: null, overheadRatePercent: null,
    }), {
      overhead: null,
      /* ── AND THE ZERO BAND IS AN APPROVED DECISION NOW ──────────────
         The distinction this test exists for did not change; where it is
         recorded did. A band of nil is a Board decision with a name and a date
         against it, and "nobody has decided" fills nothing at all. Setting it
         on the costing policy is refused. */
      /* An approved 0% markup — sell at cost. A decision somebody signed,
         and not the same record as never having decided. */
      margin: { floorMarkupPercent: "0" },
    });
    expect(saved.status).toBe(200);

    const id = await newCosting(me, co);
    const r = await calculate(me, co, id);
    expect(r.status).toBe(201);

    const s = r.body.versions[0].cost.scenarios[0];
    /* Assembled: 10,000 fabric + 354 labour = 10,354/pc, × 500 = 51,77,000,
       plus the 25,00,000 setup charge = 76,77,000 ⇒ 15,354/pc (₹153.54).
       A 0% margin means the price IS the cost — because somebody chose that,
       which is the whole point. */
    expect(s.unitCostMinor).toBe(15354);
    expect(s.totalCostMinor).toBe(7677000);
    /* The price is the cost rounded UP to the company's ₹1 step — 62,800 —
       so the realised margin is a shade above the 0% asked for, never below.
       Rounding down to a tidy number is the one direction that would breach
       the floor, which is why the step only ever goes up. */
    /* ── AN APPROVED 0% MARKUP PRICES AT COST ──────────────────────
       A decision somebody signed, applied as one: the floor equals the cost
       and no markup is added. Distinct from having no policy, which produces
       no price at all. */
    const floor = r.body.versions[0].margin.scenarios[0].floor;
    expect(floor.floorMarkupPercent).toBe("0");
    /* ── AT COST, THEN RAISED TO A PRICE SOMEBODY CAN QUOTE ────────
       The markup adds nothing; the only thing between the cost and the floor
       is the rounding to the company's saleable increment, and it goes UP —
       a floor rounded down would sit below the one management approved. So
       the whole difference is the recorded uplift, and nothing else. */
    expect(floor.markupAmountMinor).toBe(floor.roundingUpliftMinor);
    expect(floor.floorPriceMinor).toBeGreaterThanOrEqual(floor.trueUnitCostMinor);
    expect(floor.floorPriceMinor - floor.trueUnitCostMinor).toBe(floor.roundingUpliftMinor);
    expect(r.body.versions[0].margin.band.floorMarkupPercent).toBe("0");
    expect(r.body.policyConfigured).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * TWO SECTIONS ABOUT THE HTTP IDEMPOTENCY MIDDLEWARE USED TO SIT HERE
 *
 *   · "a key is bound to the costing it was spent on" — the same key aimed at
 *     a second costing refused as `IDEMPOTENCY_KEY_REUSED` rather than
 *     replayed, still refused after the bookkeeping row expired, still
 *     replaying against the same costing, and unmoved by a target in the body.
 *
 *   · "a recovered version is connected to its parent" — a version that
 *     commits while the parent's pointer update fails, repaired on the retry,
 *     and a repair that can never drag the pointer backwards.
 *
 * They drove `POST /:id/versions`, which refuses a browser client now, so the
 * middleware behind it can no longer be reached with a calculation.
 *
 * ── WHERE EACH CLAIM LIVES NOW ─────────────────────────────────────────────
 * The binding claim is the orchestration's, and it is made differently and
 * more usefully: the creation claim includes the ENQUIRY, so one action key
 * pressed on two enquiries is two estimates rather than one refusal — and,
 * crucially, never the first enquiry's costing handed to the second.
 * `sales-estimate-preparation.test.js` asserts exactly that ("one key pressed
 * on two enquiries is two estimates, not one handed over twice"), and it fails
 * without the binding.
 *
 * The pointer repair is `versionCreation.repairPointer`, unchanged and still
 * forward-only, and it is still exercised by the routes that still take a
 * write — `legacy-import`, `submit` and `approve`. What no longer has a caller
 * is a CALCULATION arriving twice through HTTP, because a calculation does not
 * arrive through HTTP at all.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══ 4 · THE MONEY CONTRACT, AT THE MODEL ══════════════════════════════ */

describe("persisted monetary results", () => {
  const version = (over) => {
    const co = new mongoose.Types.ObjectId();
    return new CostingVersion({
      companyId: co, costingId: co, versionNumber: 1, baseCurrency: "INR",
      provenance: { origin: "MANUAL", createdAt: new Date() },
      ...over,
    });
  };
  const scenario = (patch) => version({ scenarios: [{ key: "a", quantity: "1", ...patch }] });
  const refuses = (doc) => expect(doc.validateSync()).toBeTruthy();
  const accepts = (doc) => expect(doc.validateSync()).toBeFalsy();

  test("scenario totals refuse fractions, NaN, infinity and unsafe integers", () => {
    for (const bad of [412.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      refuses(scenario({ totalCostMinor: bad }));
      refuses(scenario({ unitCostMinor: bad }));
      refuses(scenario({ fixedPerUnitMinor: bad }));
      refuses(scenario({ variableTotalMinor: bad }));
    }
  });

  test("line and category results refuse them too — whoever the writer is", () => {
    refuses(scenario({ categorySubtotals: [{ category: "MATERIAL", totalMinor: 1.5, perUnitMinor: 1 }] }));
    refuses(scenario({ lines: [{ lineKey: "a", category: "MATERIAL", behaviour: "PER_UNIT", perUnitMinor: 1, totalMinor: 0.5 }] }));
    refuses(scenario({ lines: [{ lineKey: "a", category: "MATERIAL", behaviour: "PER_UNIT", perUnitMinor: 1, totalMinor: 1, taxMinor: NaN }] }));
    refuses(scenario({ lines: [{ lineKey: "a", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", perUnitMinor: 1, totalMinor: 1, basisAmountMinor: 2.5 }] }));
    refuses(version({ inputs: [{ lineKey: "a", category: "MATERIAL", behaviour: "PER_UNIT", unitRate: { amountMinor: 41250.5, currency: "INR" } }] }));
  });

  test("a selling price cannot be negative; a delta can", () => {
    refuses(scenario({ prices: { target: { requestedMarginPercent: "25", priceMinor: -1, effectiveMarginPercent: "0" } } }));
    /* Dilution IS negative — that is what it looks like — and so is a rounding
       adjustment that went the other way. */
    accepts(scenario({
      comparedToPrimary: {
        againstScenarioKey: "b", unitCostDeltaMinor: -4200,
        fixedDilutionMinor: -4200, variableChangeMinor: 0, roundingMinor: -1,
      },
    }));
    accepts(scenario({ roundingAdjustmentMinor: -1 }));
  });

  test("zero is valid, and stays distinct from missing", () => {
    accepts(scenario({ totalCostMinor: 0, unitCostMinor: 0, recoverableTaxMinor: 0 }));
    const absent = scenario({});
    accepts(absent);
    expect(absent.scenarios[0].totalCostMinor).toBeUndefined();
    expect(absent.scenarios[0].unitCostMinor).toBeUndefined();
  });

  test("nothing is silently rounded on the way in", () => {
    const doc = scenario({ totalCostMinor: 412.5 });
    /* The stored value is untouched and the document is invalid — a setter
       that rounded it would turn a caller's bug into a wrong number nobody
       could later find. */
    expect(doc.scenarios[0].totalCostMinor).toBe(412.5);
    refuses(doc);
  });
});

/* ═══ 5 · THE BASIS VOCABULARY ══════════════════════════════════════════ */

describe("percentage bases", () => {
  test("TOTAL_COST is not offered anywhere", () => {
    expect(BASIS_KEYS).not.toContain("TOTAL_COST");
    expect(BASIS_KEYS).toContain("SUBTOTAL_BEFORE_FINANCING");
    expect(BASIS_KEYS).toContain("SUBTOTAL_BEFORE_OVERHEAD");
  });

  test("the API refuses it as an unknown basis, not as a circular one", async () => {
    const co = await company("Basis");
    const me = await admin([co]);
    await savePolicy(me, co, policyBody(0));
    const id = await newCosting(me, co);

    const r = await calculate(me, co, id, newKey(), {
      /* One line, deliberately: the basis is what is under test, and a
         payload with a percentage line and nothing else still reaches the
         parser's basis check — which is where the refusal is raised. */
      lines: [{ lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", basis: "TOTAL_COST", percent: "10" }],
    });
    /* Refused at the door now — the route reads no body at all. The parser
       rule this test is named for still stands and is exercised directly,
       which is the only way left to hand it a line. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { parseLine } = require("../../services/centralCosting/calculationInput");
    let refused = null;
    try {
      parseLine({ lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS",
        basis: "TOTAL_COST", percent: "10" }, 0, "INR", new Set());
    } catch (err) { refused = err; }
    expect(refused.details.reason).toBe("BASIS_UNKNOWN");
    expect(refused.details.allowed).not.toContain("TOTAL_COST");
  });

  test("financing after overhead is expressible and correct", async () => {
    /* ── WHERE THE TWO PERCENTAGES COME FROM NOW ────────────────────────────
       This used to post an overhead line and a financing line beside a typed
       material, which made the chain a property of one request. Both are
       standing company rules, so they are stated once in the policy and the
       engine raises them on every scenario — which is what makes them
       comparable between costings at all.

       The ordering claim is unchanged and is the point: financing is charged
       on a basis that INCLUDES overhead, so 2% of (material + labour +
       overhead), not 2% of the direct cost. */
    const co = await company("Financing");
    const me = await admin([co]);
    /* 10% of SUBTOTAL_BEFORE_OVERHEAD, as this test's arithmetic below has
       always assumed — approved by the Board now rather than written into the
       policy body, which refuses it. */
    await savePolicy(me, co, policyBody(0), {
      overhead: { ratePercent: "10", basis: "SUBTOTAL_BEFORE_OVERHEAD" },
    });
    /* ── WHERE THE FINANCING PERCENTAGE COMES FROM NOW ──────────────────
       Not a flat company rate. The Board approves an annual rate and a
       methodology; Sales confirms this order's terms. 10% a year on the 100%
       still outstanding for 73 days is exactly 2% — the same figure the flat
       rule used to assert, arrived at from two records instead of one, so the
       ordering claim below is tested unchanged against the arithmetic that
       now produces it. */
    await approveFinancingPolicy(co._id, {
      annualRatePercent: "10", basis: "SUBTOTAL_BEFORE_FINANCING",
      advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
    });
    /* ── NO DEVELOPMENT CHARGE ON THIS ONE ───────────────────────────
       The arithmetic below is stated to the paisa on a single garment, so
       the costing must contain the fabric and the labour and nothing else.
       Every other world in this suite seeds a setup charge because it needs
       a fixed cost to dilute; this one would have it counted into every
       figure asserted here. */
    /* A run of one, so the percentage bases are readable straight off the
       line totals. Sales states the quantity, so the fixture states it there. */
    const id = await newCosting(me, co, null, {
      development: null,
      paymentTerms: { advancePercent: 0, creditDays: 73, creditDaysFrom: "INVOICE" },
    }, [{ key: "q1", quantity: "1", isPrimary: true }]);

    const r = await calculate(me, co, id, newKey(), { lines: [] });
    expect(r.status).toBe(201);
    const lines = Object.fromEntries(r.body.versions[0].cost.scenarios[0].lines.map((l) => [l.lineKey, l.totalMinor]));
    /* 10,000 fabric + 354 labour = 10,354; overhead 10% = 1,035.
       Financing: 10% a year x 100% financed x 73 days / 365 = 2%, charged on
       11,389 (which INCLUDES the overhead) = 228. */
    expect(lines["policy:overhead"]).toBe(1035);
    expect(lines["policy:financing"]).toBe(228);
    expect(r.body.versions[0].cost.scenarios[0].totalCostMinor).toBe(11617);

    /* ── AND THE VERSION CAN EXPLAIN THE 228 ───────────────────────────
       Both halves on the record: the Board's rule and the terms it was
       applied to. A percentage with neither is what this replaced. */
    const fin = r.body.versions[0].cost.financingProvenance;
    expect(fin.annualRatePercent).toBe("10");
    expect(fin.creditDays).toBe(73);
    expect(fin.effectivePercent).toBe("2.000000");
    expect(fin.advanceTreatment).toBe("REDUCES_FINANCED_AMOUNT");
    expect(fin.dayCountBasis).toBe(365);
    expect(fin.basis).toBe("SUBTOTAL_BEFORE_FINANCING");
  });
});

/* ═══ 6 · EVERY RULE THE CALCULATION NEEDS CAN ACTUALLY BE SET ══════════
 *
 * Found by this migration, not designed for: the policy screen could set
 * currency, rounding, the price step, overhead and the margin band — and
 * nothing else. Financing, contingency, the input-GST treatment and the four
 * production assumptions were stored on the model, copied onto every version
 * snapshot and read by the engine and the assembly, and no request could write
 * one of them.
 *
 * That was survivable while a costing could carry a typed FINANCING line and a
 * typed operation rate. Closing manual lines made it fatal: a labour rate is
 * refused without the productive basis and the employer burden, and a
 * quotation-backed material is refused without the GST treatment, so no
 * company reachable through the API could calculate a source-backed costing at
 * all. These tests exist so that cannot silently return.
 */

describe("the policy screen can set every rule a calculation reads", () => {
  /* The bare route, not this suite's `savePolicy` wrapper — the wrapper fills
     the production assumptions in behind the request, which is exactly what
     these tests must not let stand in for the write under test. */
  const putPolicy = (me, co, body) =>
    call("/policy/current", { method: "PUT", token: me.token, company: co._id, body });

  test("the rules that HAVE moved read back as read-only, and are refused on write", async () => {
    /* ── WHAT THIS TEST USED TO PROVE ─────────────────────────────────
       That contingency and the production assumptions saved and read back
       here. Both premises have since been retired: the labour assumptions,
       the input-GST treatment and now contingency are Board policies, so what
       this endpoint owes the screen is a truthful statement about each rather
       than an editor for it.

       The old body also stored `SUBTOTAL_BEFORE_OVERHEAD` as the contingency
       basis — a basis containing the contingency line's own category, which
       the engine refuses outright. It could be saved because this writer never
       checked; the Board contract now refuses it by name. */
    const co = await company("AllRules");
    const me = await admin([co]);

    const refused = await putPolicy(me, co, policyBody(0, {
      contingencyBasis: "SUBTOTAL_BEFORE_OVERHEAD", contingencyRatePercent: "1.5",
    }));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("CONTINGENCY_POLICY_MOVED");

    /* What it still owns saves and reads back. */
    expect((await putPolicy(me, co, policyBody(0))).status).toBe(200);
    const back = await call("/policy/current", { token: me.token, company: co._id });
    for (const block of ["labourPolicy", "gstPolicy", "contingencyPolicy"]) {
      expect([block, back.body.policy[block].editable]).toEqual([block, false]);
      expect([block, back.body.policy[block].ownedBy]).toEqual([block, "BOARD"]);
    }
  });

  /* ═══ THE COSTING POLICY IS NO LONGER A WAY TO SET FINANCING ══════════
   *
   * It was, and being able to was the problem: the cost of money is a
   * governed decision with a methodology, an approver and an effective date,
   * and a second place it could be typed would mean two financing rules with
   * nothing deciding which one applied.
   *
   * The fields stay READABLE — versions frozen under the old flat rate have
   * to remain explicable, and a company holding one has to be able to see it
   * — and the only write still accepted is the one that clears it. */

  test("setting a financing rate through the costing policy is refused by name", async () => {
    const co = await company("FinMoved");
    const me = await admin([co]);

    const r = await putPolicy(me, co, policyBody(0, {
      financingBasis: "SUBTOTAL_BEFORE_FINANCING", financingRatePercent: "2",
    }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("FINANCING_POLICY_MOVED");
    /* Named, not silently dropped: ignoring the field would leave whoever
       sent it believing the rate was saved. */
    expect(r.body.error.details.field).toBe("financingBasis");
    expect(r.body.error.details.ownedBy).toBe("BOARD");

    /* And nothing was written — not even the rest of the request. */
    const doc = await CostingPolicy.findOne({ companyId: co._id }).lean();
    expect(doc).toBeNull();
  });

  test("a rate alone is refused too, so there is no half-open path", async () => {
    const co = await company("FinMovedHalf");
    const me = await admin([co]);
    const r = await putPolicy(me, co, policyBody(0, { financingRatePercent: "3" }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("FINANCING_POLICY_MOVED");
    expect(r.body.error.details.field).toBe("financingRatePercent");
  });

  test("a legacy rate stays readable, is marked uneditable, and can be cleared", async () => {
    const co = await company("FinLegacy");
    const me = await admin([co]);
    await putPolicy(me, co, policyBody(0, {}));
    /* Written the way history was: straight to the collection, because the
       route that put it there is closed. This is a fact about the database,
       not an operation anybody performs. */
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { financingBasis: "SUBTOTAL_BEFORE_FINANCING", financingRatePercent: "2" } },
    );

    const back = await call("/policy/current", { token: me.token, company: co._id });
    expect(back.body.policy.financingRatePercent).toBe("2");
    expect(back.body.policy.financingPolicy.editable).toBe(false);
    expect(back.body.policy.financingPolicy.ownedBy).toBe("BOARD");
    expect(back.body.policy.financingPolicy.legacyRatePresent).toBe(true);

    /* Clearing is the one write still accepted — a company retiring the old
       rate should be able to, without that being a way to set a new one. */
    const cleared = await putPolicy(me, co, policyBody(back.body.revision, {
      financingBasis: null, financingRatePercent: null,
    }));
    expect(cleared.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: co._id }).lean();
    expect(doc.financingBasis).toBeUndefined();
    expect(doc.financingRatePercent).toBeUndefined();
  });

  test("the labour assumptions can no longer be set here, and say so by name", async () => {
    /* ── THIS USED TO PIN THE BOTH-BASES REFUSAL ───────────────────────
       The either-or rule went with the methodology to the Board — see
       `boardPolicy.labourGaps` and `validateLabour`, which refuse both-at-once
       at the write and neither-at-all at approval. What this endpoint enforces
       now is that it is not a second writer. */
    const co = await company("LabourMoved");
    const me = await admin([co]);
    for (const patch of [
      { productiveMinutesPerMonth: 9000 },
      { labourEfficiencyPercent: "72" },
      { employerBurdenPercent: "18" },
      { machineBurdenTreatment: "IN_OVERHEAD" },
    ]) {
      const r = await putPolicy(me, co, policyBody(0, patch));
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("LABOUR_POLICY_MOVED");
      expect(r.body.error.details.ownedBy).toBe("BOARD");
      expect(r.body.error.details.fields).toHaveLength(4);
    }
    /* And nothing was written — not even the rest of the request. */
    expect(await CostingPolicy.countDocuments({ companyId: co._id })).toBe(0);
  });
});

/* ═══ 7 · CONCURRENT POLICY EDITS ═══════════════════════════════════════ */

describe("company policy concurrency", () => {
  test("two editors from the same revision: one wins, the other is told", async () => {
    const co = await company("Concurrent");
    const me = await admin([co]);
    await savePolicy(me, co, policyBody(0));

    const loaded = await call("/policy/current", { token: me.token, company: co._id });
    expect(loaded.body.revision).toBe(1);

    /* Two people editing DIFFERENT fields from the same revision. Overhead and
       now contingency are Board policies, so the claim is made with a field the
       costing policy still owns — what is under test is the revision, not
       which setting. */
    const first = await savePolicy(me, co, policyBody(1, {
      sellingPriceIncrementMinor: 500,
    }));
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(2);

    /* WAS: this wrote its stale copy of the whole policy back, silently
       erasing the first change. */
    /* A field the costing policy still owns: writing a margin here would be
       refused as moved before the revision check could run, and the race this
       test exists for would never happen. */
    const second = await savePolicy(me, co, policyBody(1, { roundingMode: "HALF_EVEN" }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("POLICY_REVISION_CONFLICT");
    expect(second.body.error.details.currentRevision).toBe(2);

    /* The first change survives, and the second changed nothing. */
    const now = await CostingPolicy.findOne({ companyId: co._id }).lean();
    expect(now.sellingPriceIncrementMinor).toBe(500);
    expect(now.roundingMode).toBe("HALF_UP");
    expect(now.revision).toBe(2);
  });

  test("a successful change increments the revision exactly once", async () => {
    const co = await company("Increment");
    const me = await admin([co]);
    expect((await savePolicy(me, co, policyBody(0))).body.revision).toBe(1);
    /* Fields the costing policy still owns — the margin band is the Board's
       now, so writing it here would be testing a refusal. */
    expect((await savePolicy(me, co, policyBody(1, { sellingPriceIncrementMinor: 500 }))).body.revision).toBe(2);
    expect((await savePolicy(me, co, policyBody(2, { sellingPriceIncrementMinor: 200 }))).body.revision).toBe(3);
    expect((await CostingPolicy.findOne({ companyId: co._id }).lean()).revision).toBe(3);
  });

  test("a write with no revision is refused rather than assumed to be current", async () => {
    const co = await company("NoRevision");
    const me = await admin([co]);
    const r = await savePolicy(me, co, { ...POLICY });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("POLICY_REVISION_REQUIRED");
    expect(await CostingPolicy.countDocuments({})).toBe(0);
  });

  test("two simultaneous first writes: one creates, the other is a conflict", async () => {
    const co = await company("FirstWrite");
    const me = await admin([co]);
    const [a, b] = await Promise.all([
      /* Two fields the costing policy still owns: the margin band is the
         Board's now, so one of these would be refused for the wrong reason and
         the race would never be run. */
      savePolicy(me, co, policyBody(0, { sellingPriceIncrementMinor: 500 })),
      savePolicy(me, co, policyBody(0, { roundingMode: "HALF_EVEN" })),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe("POLICY_REVISION_CONFLICT");
    expect(await CostingPolicy.countDocuments({ companyId: co._id })).toBe(1);
    expect((await CostingPolicy.findOne({ companyId: co._id }).lean()).revision).toBe(1);
  });
});

/* ═══ 7 · NOTHING ELSE MOVED ════════════════════════════════════════════ */

describe("existing guarantees still hold", () => {
  test("a frozen version is unchanged by everything above", async () => {
    const co = await company("Frozen");
    const me = await admin([co]);
    await savePolicy(me, co, policyBody(0));
    const id = await newCosting(me, co);
    const made = await calculate(me, co, id);
    const before = await CostingVersion.findById(made.body.versions[0].id).lean();

    /* ── THE POLICY CHANGE THAT MATTERS IS THE BOARD'S NOW ────────────
       Raising the band is what would re-price a costing if anything could, and
       it is a Board approval rather than a costing-policy save. Approved with
       a LATER effective date, which is the only way a band changes: the frozen
       version copied its own, and a copy cannot be reached by a later
       decision. */
    await approveMarginPolicy(co._id, {
      floorMarkupPercent: "40",
      effectiveFrom: new Date(Date.now() - 1 * 24 * 3600 * 1000),
    });
    await calculate(me, co, id);

    const after = await CostingVersion.findById(made.body.versions[0].id).lean();
    expect(after).toEqual(before);
  });
});
