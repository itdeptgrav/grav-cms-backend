// test/costing/costing-completeness.test.js
//
// Central Costing — Chunk 4C. HAVE WE ADDRESSED EVERY WAY THIS COSTS MONEY?
//
// A costing with one fabric line used to produce a confident total, a margin
// and a selling price while packaging, freight, duty, financing and overhead
// had never been considered. The sections simply did not appear, and an absent
// section reads as "none needed" rather than "nobody has looked".
//
// The claim that matters is the one about zero. A freight cost of nil because
// the customer collects is a RESULT; a freight cost of nil because the field
// is empty is a QUESTION. They look identical in a total, so they are never
// stored the same way — and only the second blocks review.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, approveMarginPolicy, CONFIRMED_TERMS,
  EVERY_FAMILY, prepareAsRoute,
} = require("./helpers/sourceBacked");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const coverage = require("../../services/centralCosting/costCoverage");

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_complete" });
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const newKey = () => `cc-${++seq}-${Math.random().toString(36).slice(2)}`;

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


/* ═══ 1 · THE FIVE STATES, ON THEIR OWN ═══════════════════════════════════ */

const sub = (category, totalMinor, perUnitMinor) => ({ category, totalMinor, perUnitMinor });
const scenarioOf = (subtotals) => ({ key: "q500", isPrimary: true, categorySubtotals: subtotals });
const stateOf = (a, key) => a.families.find((f) => f.key === key).state;

describe("every cost family resolves to one of five states", () => {
  test("a costing with only material cost is not complete", () => {
    const a = coverage.assess({ scenario: scenarioOf([sub("MATERIAL", 100000, 20000)]) });
    expect(stateOf(a, "materials")).toBe(coverage.STATE.CALCULATED);
    /* Eight families nobody has looked at. The total was never wrong — it was
       answering a smaller question than the screen implied. */
    expect(a.costComplete).toBe(false);
    expect(a.outstanding).toHaveLength(8);
    expect(a.outstanding.every((o) => o.state === coverage.STATE.NEEDS_INPUT)).toBe(true);
  });

  test("an absent family is not zero", () => {
    const a = coverage.assess({ scenario: scenarioOf([sub("MATERIAL", 100000, 20000)]) });
    const freight = a.families.find((f) => f.key === "freight");
    expect(freight.state).toBe(coverage.STATE.NEEDS_INPUT);
    /* Null, never 0 — writing zero would put it in a total as though it had
       been costed and found to be nothing. */
    expect(freight.totalMinor).toBeNull();
    expect(freight.perUnitMinor).toBeNull();
  });

  test("an authoritative zero is a result, and is told apart from an absent one", () => {
    const a = coverage.assess({ scenario: scenarioOf([sub("FREIGHT", 0, 0)]) });
    /* The customer collects. A real rule produced nil. */
    expect(stateOf(a, "freight")).toBe(coverage.STATE.RECORDED_ZERO);
    expect(a.families.find((f) => f.key === "freight").totalMinor).toBe(0);
    /* And it does not block anything. */
    expect(a.outstanding.some((o) => o.key === "freight")).toBe(false);
  });

  test("a source-owned not-applicable answers the family without inventing an amount", () => {
    const a = coverage.assess({
      scenario: scenarioOf([]),
      /* Read from Store's quotation, not sent with the calculation. */
      sourceDecisions: {
        duty: {
          key: "duty",
          reason: "Domestic order — nothing is imported.",
          decidedByName: "R Ray",
          basis: "Store recorded domestic sourcing on every material's quotation",
          ownerDepartment: "Store / Purchase",
        },
      },
    });
    const duty = a.families.find((f) => f.key === "duty");
    expect(duty.state).toBe(coverage.STATE.NOT_APPLICABLE);
    expect(duty.reason).toBe("Domestic order — nothing is imported.");
    expect(duty.decidedBy).toBe("R Ray");
    /* WHICH record answered — checkable, where "marked not applicable on this
       version" was not. */
    expect(duty.basis).toMatch(/Store recorded domestic sourcing/);
    expect(duty.decidedByDepartment).toBe("Store / Purchase");
    /* Their judgement, not a costed nil. */
    expect(duty.totalMinor).toBeNull();
  });

  test("materials, operations and overhead have no not-applicable at all", () => {
    /* ── THE FAMILIES NOBODY MAY EXCUSE ────────────────────────────────
       A garment is made of something, somebody makes it, and the Board owns
       the overhead rate including an approved zero. A decision naming one of
       them is dropped rather than honoured — second layer behind the payload
       refusal, so an internal caller cannot excuse what no record answers. */
    const a = coverage.assess({
      scenario: scenarioOf([]),
      sourceDecisions: {
        materials: { key: "materials", reason: "This garment has no materials.", basis: "b" },
        operations: { key: "operations", reason: "Nobody makes it.", basis: "b" },
        overhead: { key: "overhead", reason: "We have no overhead.", basis: "b" },
      },
    });
    for (const key of ["materials", "operations", "overhead"]) {
      expect(stateOf(a, key)).toBe(coverage.STATE.NEEDS_INPUT);
      expect(a.families.find((f) => f.key === key).applicabilityOwner).toBeNull();
    }
    expect(a.costComplete).toBe(false);
  });

  test("freight and financing are answered by a line, never by a family decision", () => {
    /* Sales' arrangement produces a RECORDED ZERO and their stated
       not-applicable produces a nil FINANCING line with the reason on it.
       Neither needs — or may have — a family-level escape, which is what made
       "this delivered order does not need freight" possible. */
    for (const key of ["freight", "financing"]) {
      const a = coverage.assess({
        scenario: scenarioOf([]),
        sourceDecisions: { [key]: { key, reason: "We will absorb it.", basis: "b" } },
      });
      expect(stateOf(a, key)).toBe(coverage.STATE.NEEDS_INPUT);
    }
  });

  test("real cost outranks a later decision — a decision cannot un-cost money", () => {
    const a = coverage.assess({
      scenario: scenarioOf([sub("PACKAGING", 5000, 1000)]),
      sourceDecisions: { packaging: { key: "packaging", reason: "Customer supplies packaging.", basis: "b" } },
    });
    /* The lines are there and they were costed. Reporting NOT_APPLICABLE over
       them would describe a version that charged for packaging as one that
       decided it did not apply. */
    expect(stateOf(a, "packaging")).toBe(coverage.STATE.CALCULATED);
  });

  test("a declared policy rule that produced nothing is a source failure, not a gap", () => {
    const a = coverage.assess({
      scenario: scenarioOf([sub("MATERIAL", 100000, 20000)]),
      policySnapshot: { overheadRatePercent: "12" },
    });
    /* Different from NEEDS_INPUT: nobody failed to act, something failed to
       answer, and the fix is not "type a number". */
    expect(stateOf(a, "overhead")).toBe(coverage.STATE.SOURCE_UNAVAILABLE);
    expect(a.costComplete).toBe(false);
  });

  test("every family answered by cost, policy or a source decision is complete", () => {
    const a = coverage.assess({
      scenario: scenarioOf([
        sub("MATERIAL", 100000, 20000),
        sub("OPERATION", 30000, 6000),
        sub("PACKAGING", 5000, 1000),
        sub("OVERHEAD", 16000, 3200),
        /* Two real nils — the customer collects, and Sales recorded that this
           order is not financed. Both are ANSWERS, produced as lines. */
        sub("FREIGHT", 0, 0),
        sub("FINANCING", 0, 0),
      ]),
      policySnapshot: { overheadRatePercent: "12" },
      /* Financing is NOT here: it is answered by the nil line Sales' own
         decision produces, and there is deliberately no family escape for it.
         So the scenario carries that line, the way a real one would. */
      sourceDecisions: {
        services: { key: "services", reason: "Nothing sent outside for this style.", basis: "b" },
        duty: { key: "duty", reason: "Domestic order.", basis: "b" },
        development: { key: "development", reason: "Pattern already exists from an earlier order.", basis: "b" },
      },
    });
    expect(a.costComplete).toBe(true);
    expect(a.outstanding).toEqual([]);
  });

  test("income tax is not one of the cost families", () => {
    /* It sits below profit, outside product cost. A company with no
       income-tax estimate has an incomplete PROFIT picture and a perfectly
       complete COST. */
    expect(coverage.FAMILY_KEYS).not.toContain("incomeTax");
    expect(JSON.stringify(coverage.FAMILIES)).not.toMatch(/income tax/i);
  });

  test("the second checklist is gone, and its keys with it", () => {
    /* `technicalSource.UNRESOLVED` was four named groups beside these
       families, answerable by a costing line or a Costing-side decision. Three
       of the four ARE these families and have real records now; the fourth,
       `embellishment`, had no record, no department and no family, and could
       be closed only the one way this task retires.

       Two lists over one question is how a family reads "answered" on one
       panel and "open" on the other. */
    const technical = require("../../services/centralCosting/technicalSource.service");
    expect(technical.UNRESOLVED).toBeUndefined();
    expect(technical.resolveUnresolved).toBeUndefined();
    for (const shared of ["packaging", "services", "development"]) {
      expect(coverage.FAMILY_KEYS).toContain(shared);
    }
  });

  test("every family that may be excused names the department that may excuse it", () => {
    /* A blocking state with no address is a dead end, and a dead end is what
       sent people to declare the family away in Costing. */
    const a = coverage.assess({ scenario: scenarioOf([]) });
    const owners = Object.fromEntries(a.families.map((f) => [f.key, f.applicabilityOwner]));
    expect(owners.packaging.department).toBe("Merchandising");
    expect(owners.services.department).toBe("Production");
    expect(owners.development.department).toBe("Merchandising");
    expect(owners.duty.department).toBe("Store / Purchase");
    for (const key of ["materials", "operations", "freight", "financing", "overhead"]) {
      expect(owners[key]).toBeNull();
    }
  });
});


/* ═══ 2 · THE FOUR READINESS ANSWERS ══════════════════════════════════════ */

describe("readiness is four separate questions", () => {
  const complete = { costComplete: true, outstanding: [] };
  const incomplete = { costComplete: false, outstanding: [{ key: "freight", label: "Freight and logistics" }] };
  const scenarios = [{ key: "a" }, { key: "b" }, { key: "c" }];

  test("a missing income-tax rate blocks only the after-tax estimate", () => {
    const r = coverage.readiness({
      completeness: complete,
      scenarios,
      commercial: { proposedPrices: scenarios.map((s) => ({ scenarioKey: s.key })) },
    });
    expect(r.cost.ready).toBe(true);
    expect(r.selling.ready).toBe(true);
    /* The product cost is complete and approvable. Only the profit-after-tax
       question is unanswered. */
    expect(r.afterTax.ready).toBe(false);
    expect(r.afterTax.taxRateConfigured).toBe(false);
    expect(r.approval.ready).toBe(true);
  });

  test("a configured 0% rate is a configured rate", () => {
    const r = coverage.readiness({
      completeness: complete,
      scenarios,
      commercial: {
        estimatedIncomeTaxRatePercent: "0",
        proposedPrices: scenarios.map((s) => ({ scenarioKey: s.key })),
      },
    });
    /* A company in a tax holiday has decided something. Treating "0" as
       missing would discard the decision. */
    expect(r.afterTax.taxRateConfigured).toBe(true);
    expect(r.afterTax.ready).toBe(true);
  });

  test("selling readiness counts the quantities, and names the unpriced ones", () => {
    const r = coverage.readiness({
      completeness: complete,
      scenarios,
      commercial: { proposedPrices: [{ scenarioKey: "a" }, { scenarioKey: "b" }] },
    });
    expect(r.selling.ready).toBe(false);
    expect(r.selling.priced).toBe(2);
    expect(r.selling.total).toBe(3);
    expect(r.selling.unpriced).toEqual(["c"]);
  });

  test("an incomplete cost blocks approval and lists what is missing", () => {
    const r = coverage.readiness({ completeness: incomplete, scenarios, commercial: null });
    expect(r.approval.ready).toBe(false);
    expect(r.approval.blockedBy).toHaveLength(1);
  });

  test("an unassessed version is neither ready nor failed", () => {
    const r = coverage.readiness({ completeness: null, scenarios, commercial: null });
    /* Null, not false. A legacy version was never assessed, which is not the
       same as having been assessed and found wanting. */
    expect(r.cost.ready).toBeNull();
    expect(r.cost.recorded).toBe(false);
    expect(r.approval.ready).toBe(false);
    expect(r.approval.recorded).toBe(false);
  });
});


/* ═══ 3 · THE VERSION FREEZES IT, AND REVIEW IS GATED ON IT ═══════════════ */

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(companies = []) {
  const n = ++seq;
  const email = `cc-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "C", lastName: `L${n}`, email, biometricId: `CC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "C Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* The margin band is an approved Board decision now; the costing policy
     refuses the three fields and `configureProduction` approves the Board's at
     the same 18/25/32. */
  /* Overhead is answered as the standing rule it is, so its family is
     complete without a typed line. Financing is NOT a standing rule any
     more — see `world()`, which answers it the way the company now does:
     an approved Board methodology plus the terms Sales confirmed. */
  revision: 0,
};

/* ── FABRICATING A GENUINELY OLD DOCUMENT ──────────────────────────────────
   Straight through the driver, bypassing mongoose middleware on purpose. The
   model refuses to mutate a frozen version — correctly — so the app has no
   path that produces these states. What is being simulated is a document
   written before this chunk existed, which is a fact about the database, not
   an operation anybody performs. */
const asLegacy = (versionId, update) =>
  CostingVersion.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(versionId)) }, update,
  );

/* ── EVERY LINE HERE IS A DECLARED OVERRIDE, AND THAT IS THE POINT ────────
 * These families had no source when this suite was written, so the only way
 * to answer them was by hand, declaring the family and the reason. That is
 * what these rows are.
 *
 * ── AND FREIGHT IS NO LONGER ONE OF THEM ─────────────────────────────────
 * It has a source now: who bears the delivery on the enquiry, what the
 * garment ships as on the sample, and a transporter's own quotation for the
 * lane. A typed freight figure is REFUSED, so the row that used to sit here
 * is gone and the fixture's enquiry answers it instead — `ex_works`, the
 * customer collects, which is a recorded zero rather than a gap.
 *
 * Materials, operations, overhead and financing are NOT here. They have
 * sources: the technical record, the supplier quotation, and the company
 * policy's overhead and financing rules. The fixture supplies all four, and a
 * test that typed them would be asserting its own arithmetic. */
/* ── NO FAMILY IS ANSWERED BY HAND ANY MORE ──────────────────────────
   `FULL_LINES` was the four families "still answered by hand" — packaging,
   development, outside services and customs duty — each a declared override
   with a family and a reason.

   Three of them acquired sources, and the seed states all three. The fourth,
   customs duty, still has none: nothing here records an import
   classification. It is answered the only honest way an unrecorded fact can
   be — a decision that it does not apply, with a reason — which is precisely
   what several tests below are about.

   So `COMPLETE` is what a complete costing now looks like on the wire: no
   lines, and one decision. */
const COMPLETE = { };

const SCEN = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

async function world(seedOver = {}) {
  const co = await company("Cover");
  const me = await actor([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  /* ── THE FOUR FAMILIES THAT DO HAVE SOURCES ──────────────────────────────
     Materials and operations come off the technical record, the supplier
     quotation and the production assumptions; overhead and financing are
     standing company rules. This is what "complete" means for them — the
     costing reads them, nobody types them. */
  /* ── AND FINANCING TAKES TWO RECORDS, NOT A POLICY FIELD ────────────
     The Board's approved methodology, and this order's confirmed payment
     terms. Both are needed: with only one of them the family is honestly
     outstanding, which several tests below rely on. */
  await approveFinancingPolicy(co._id);
  /* Packaging, outside services and development each get a requirement and a
     quotation, so the families they answer are CALCULATED from records. */
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCEN, quantityUom: "Pieces" },
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, ...seedOver,
  });
  await configureProduction(co._id);
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return {
    co, me, seeded, costingId: made.body.costing.id,
    ctxWithActor: {
      companyId: co._id,
      actorId: String(me.emp._id),
      actorName: "C Actor",
      capabilitySet: new Set([
        "costing.draft.write", "costing.cost.read", "costing.margin.read",
        "costing.output.read", "costing.approve",
        /* Preparing requires its own grant now — see
           `sales-prepare-authorisation.test.js`. This is an authorised actor. */
        "costing.prepare",
      ]),
    },
  };
}

/* ── PREPARED THE WAY SALES DOES ────────────────────────────────────────────
 * `POST /:id/versions` was the Calculate button and now refuses a browser
 * client. `extra` is still posted where a test is about the PAYLOAD contract —
 * those go to the retired door on purpose, and get its refusal. */
const calc = (w, lines, extra = {}) => (
  Object.keys(extra).length
    ? call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines, ...extra },
    })
    : prepareAsRoute(w.ctxWithActor, { enquiryId: w.seeded.enquiry._id, product: w.seeded.product })
);

const submit = (w, versionId) => call(`/${w.costingId}/versions/${versionId}/submit`, {
  method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
});

const approve = (w, versionId) => call(`/${w.costingId}/versions/${versionId}/approve`, {
  method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
  body: { note: "Approved for the season." },
});

describe("the frozen snapshot, and what it gates", () => {
  test("the assessment is server-derived and frozen with the version", async () => {
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    expect(r.status).toBe(201);

    const c = r.body.versions[0].cost.completeness;
    expect(c.recorded).toBe(true);
    expect(c.costComplete).toBe(true);
    expect(c.families).toHaveLength(9);
    expect(c.assessedAt).toBeTruthy();
    expect(c.coverageSchemaVersion).toBe(1);

    const stored = await CostingVersion.findById(r.body.versions[0].id).lean();
    expect(stored.completeness.costComplete).toBe(true);
  });

  test("a browser cannot declare itself complete", async () => {
    /* Deliberately a world with a genuine gap — nobody has recorded a
       packaging requirement, and nobody has said the style ships loose. */
    const w = await world({ packaging: null });
    /* Nothing posted: a client that could post a line would be refused, and
       the claim under test is about the completeness KEYS a body may carry,
       which the parser drops whatever else the body contains. */
    const r = await calc(w, [], {
      /* A hopeful client, claiming it every way the body allows. */
      completeness: { costComplete: true, families: [], assessedAt: new Date().toISOString() },
      costComplete: true,
      coverage: { costComplete: true },
    });
    /* The claim is about the completeness KEYS a body may carry. The route
       refuses a browser client outright now, so the stronger statement is
       that nothing it sends is read at all — and the parser whitelist below
       is what proves the keys were never trusted. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const parsed = require("../../services/centralCosting/calculationInput")
      .parseCalculationRequest({
        lines: [{
          lineKey: "x", category: "MATERIAL", behaviour: "PER_UNIT",
          unitRate: { amountMinor: 100, currency: "INR" }, quantityPerUnit: "1", quantityUom: "u",
        }],
        completeness: { costComplete: true },
        costComplete: true,
      }, { currency: "INR" });
    /* The whitelist IS the guard: a key the parser never reads cannot be
       trusted by anything that follows it. */
    expect(parsed.completeness).toBeUndefined();
    expect(parsed.costComplete).toBeUndefined();
  });

  test("a not-applicable decision records the department that made it, and when", async () => {
    /* Store stated DOMESTIC on the quotation, months before this costing was
       raised. Nothing about the calculation says so, and nobody costing the
       garment was asked. */
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    expect(r.status).toBe(201);
    const duty = r.body.versions[0].cost.completeness.families.find((f) => f.key === "duty");
    expect(duty.state).toBe("NOT_APPLICABLE");
    expect(duty.reason).toMatch(/bought in India/);
    /* ── AND THE SIGNATURE IS NOT THE CALCULATOR'S ───────────────────
       This used to stamp `ctx.actorId` — whoever pressed Calculate became the
       author of every exclusion on the version. The frozen family now names
       the owning department, and the actor where the record carries one. */
    expect(duty.decidedByDepartment).toBe("Store / Purchase");
    expect(duty.decidedIn).toMatch(/sourcing origin/);
    expect(duty.basis).toMatch(/Store recorded domestic sourcing/);
  });

  test("a departmental decision freezes as evidence with its author and date", async () => {
    /* Merchandising said this style ships loose, on 1 June, and signed it. */
    const w = await world({
      packaging: null,
      applicability: { packaging: false, packagingReason: "The customer supplies all packaging." },
    });
    const r = await calc(w, [], COMPLETE);
    expect(r.status).toBe(201);

    const stored = await CostingVersion.findById(r.body.versions[0].id).lean();
    const ref = (stored.sourceReferences || []).find((x) => x.sourceKey === "not-applicable:packaging");
    expect(ref).toBeTruthy();
    /* Not MANUAL_ENTRY. Nobody typed this into a costing. */
    expect(ref.sourceType).toBe("DEPARTMENT_DECISION");
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text]));
    expect(snap.decision).toBe("NOT_APPLICABLE");
    expect(snap.reason).toBe("The customer supplies all packaging.");
    expect(snap.decidedBy).toBe("A Fixture Decider");
    expect(snap.department).toBe("Merchandising");
    expect(snap.recordedIn).toMatch(/Packaging components/);

    const family = stored.completeness.families.find((f) => f.key === "packaging");
    expect(family.state).toBe("NOT_APPLICABLE");
    expect(family.decidedByName).toBe("A Fixture Decider");
    /* The date the department decided, not the date this was costed. */
    expect(new Date(family.decidedAt).toISOString()).toMatch(/^2026-06-01/);
  });

  test("an applicability decision sent with the calculation is refused, not stripped", async () => {
    /* ── AND SILENTLY DROPPING IT WOULD BE WORSE ─────────────────────
       The costing would calculate from whatever the departments had actually
       decided — possibly not what the person pressing Calculate believes they
       excluded — and the version would be right and unexplainable. */
    const w = await world();
    const r = await calc(w, [], {
      technicalAcknowledgements: [{ key: "packaging", reason: "Customer supplies packaging." }],
    });
    /* ── AND THE DOOR IS SHUT BEFORE THE PAYLOAD IS READ ──────────────
       Preparing an estimate is a Sales action; this route refuses a browser
       client outright, so an acknowledgement never reaches the parser. The
       parser's own refusal, with the owning desk on it, is asserted directly
       in `costing-applicability.test.js` — where it can be, without a route
       in the way. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(r.body.error.details.owner.department).toBe("Sales");
  });

  test("an empty acknowledgement list is refused too", async () => {
    /* A client sending `[]` still believes it owns this decision, and the
       next thing it sends will not be empty. */
    const w = await world();
    const r = await calc(w, [], { technicalAcknowledgements: [] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
  });

  test("materials and operations name no desk, because none may excuse them", async () => {
    const w = await world();
    const r = await calc(w, [], {
      technicalAcknowledgements: [
        { key: "materials", reason: "This garment has no materials." },
        { key: "operations", reason: "Nobody makes it." },
      ],
    });
    /* The route refuses first. That families nobody may excuse are named as
       such is asserted on the parser in `costing-applicability.test.js`. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
  });

  test("a decision made after a version was frozen does not reach back into it", async () => {
    /* ── WHAT THIS TEST USED TO SAY ────────────────────────────────────
       "Marking a previously COSTED family N/A keeps the earlier version's
       evidence" — the second version carried an acknowledgement the first did
       not. The decision now lives on the style rather than on the payload, so
       the shape of the demonstration changes and the claim does not: a
       version records the world as it stood, and a later answer is a later
       version. */
    const w = await world({ packaging: null });
    const first = await calc(w, []);
    expect(first.body.versions[0].cost.completeness.families
      .find((f) => f.key === "packaging").state).toBe("NEEDS_INPUT");

    /* Merchandising answers, in their own record, afterwards. */
    const style = await SampleStyle.findById(w.seeded.style._id);
    style.materials.packagingDecision = {
      required: false, reason: "The customer supplies all packaging.",
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "A Merchandiser" },
      decidedAt: new Date("2026-07-01"),
    };
    style.markModified("materials.packagingDecision");
    await style.save();

    const second = await calc(w, []);
    expect(second.status).toBe(201);

    const back = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v1 = back.body.versions.find((x) => x.id === first.body.versions[0].id);
    const v2 = back.body.versions.find((x) => x.id === second.body.versions[0].id);
    expect(v1.cost.completeness.families.find((f) => f.key === "packaging").state).toBe("NEEDS_INPUT");
    expect(v2.cost.completeness.families.find((f) => f.key === "packaging").state).toBe("NOT_APPLICABLE");
  });

  test("a historical acknowledgement stays readable exactly as it was frozen", async () => {
    /* ── THE RETIREMENT IS ABOUT MAKING NEW ONES ──────────────────────
       Versions frozen while Costing owned this decision carry a MANUAL_ENTRY
       reference and a family stamped with whoever was costing. Rewriting or
       reinterpreting them would destroy the only record of what the company
       actually did. */
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    const versionId = r.body.versions[0].id;
    await asLegacy(versionId, {
      $push: {
        sourceReferences: {
          sourceType: "MANUAL_ENTRY",
          sourceKey: "not-applicable:embellishment",
          label: "Not applicable — Printing, embroidery, washing and testing",
          confidence: "PROVISIONAL",
          capturedAt: new Date("2026-02-01"),
          snapshot: [
            { key: "unresolvedGroup", text: "embellishment" },
            { key: "decision", text: "NOT_APPLICABLE" },
            { key: "reason", text: "Nothing printed on this style." },
          ],
        },
      },
    });

    const v = await CostingVersion.findById(versionId).lean();
    const old = (v.sourceReferences || []).find((x) => x.sourceKey === "not-applicable:embellishment");
    expect(old).toBeTruthy();
    expect(old.sourceType).toBe("MANUAL_ENTRY");
    const snap = Object.fromEntries(old.snapshot.map((f) => [f.key, f.text]));
    expect(snap.reason).toBe("Nothing printed on this style.");
    /* Its group no longer exists as a live vocabulary, and the record of it
       is unaffected by that. */
    expect(snap.unresolvedGroup).toBe("embellishment");
  });

  test("income tax has no bearing on costComplete", async () => {
    const w = await world();
    const noRate = await calc(w, [], COMPLETE);
    expect(noRate.body.versions[0].cost.completeness.costComplete).toBe(true);

    /* ── THE TAX ESTIMATE IS A BOARD POLICY NOW ──────────────────────
       It moved with the margin band — it is a profit assumption read beside
       it — so the costing policy refuses it. Approved here as a company would,
       superseding the band `configureProduction` already put in force. */
    await approveMarginPolicy(w.co._id, {
      estimatedIncomeTaxRatePercent: "25",
      effectiveFrom: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    });
    const withRate = await calc(w, [], COMPLETE);
    /* Identical. The tax assumption is about profit, not about what the
       garment costs to make. */
    expect(withRate.body.versions[0].cost.completeness.costComplete).toBe(true);
  });

  test("submit for review is refused while a cost family is unanswered, listing all of them", async () => {
    /* ── A COMPANY THAT HAS NOT RECORDED THREE OF ITS FAMILIES ───────
       The other worlds in this suite seed packaging, outside services and
       development so their families are CALCULATED. This one deliberately
       does not: the claim being tested is that EVERY gap arrives in one
       response, and a single outstanding family cannot demonstrate it.

       The gaps are real ones — nobody has recorded a packaging requirement,
       a required process or the setup work for this style — which is exactly
       the state this refusal exists for. */
    const w = await world({ packaging: null, service: null, development: null });
    const r = await calc(w, []);
    const versionId = r.body.versions[0].id;
    /* A version may stay a DRAFT for ever while incomplete — that is what a
       draft is for. */
    expect(r.body.versions[0].status).toBe("DRAFT");

    const s = await submit(w, versionId);
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("COSTING_COST_INCOMPLETE");
    /* EVERY gap in one response. Being told about packaging, fixing it, and
       then being told about freight is how a submission takes five attempts. */
    /* Freight is not among them: the fixture's enquiry says the customer
       collects, so it is answered — with a recorded zero — rather than
       outstanding. */
    /* ── AND DUTY IS NOT AMONG THEM ANY MORE ───────────────────────
       Store stated DOMESTIC on the quotation, so the customs half of that
       family is answered by a record rather than by a reason somebody typed.
       Three gaps remain, which is still the plural this claim needs. */
    expect(s.body.error.details.outstanding).toHaveLength(3);
    expect(s.body.error.details.outstanding.map((o) => o.key).sort()).toEqual(
      ["development", "packaging", "services"],
    );
    /* And nothing moved. */
    const after = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    expect(after.body.versions.find((x) => x.id === versionId).status).toBe("DRAFT");
  });

  test("a complete costing submits and approves", async () => {
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    const versionId = r.body.versions[0].id;
    expect((await submit(w, versionId)).status).toBe(200);
    expect((await approve(w, versionId)).status).toBe(200);
  });

  test("an older IN_REVIEW version cannot walk through the gate it predates", async () => {
    /* A real gap: nobody has recorded a packaging requirement, and nobody has
       said the style ships loose. */
    const w = await world({ packaging: null });
    const r = await calc(w, []);
    const versionId = r.body.versions[0].id;

    /* A version put into review before this rule existed. */
    await asLegacy(versionId, { $set: { status: "IN_REVIEW" } });

    const a = await approve(w, versionId);
    /* Otherwise the rule applies to everything except the versions that
       predate it — the set most likely to need it. */
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("COSTING_COST_INCOMPLETE");
    expect(a.body.error.details.operation).toBe("APPROVE");
  });

  test("a legacy version with no snapshot is never treated as complete", async () => {
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    const versionId = r.body.versions[0].id;
    /* As it would be if it had been frozen before coverage was assessed. */
    await asLegacy(versionId, { $unset: { completeness: "" } });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === versionId);
    /* Readable, and honestly labelled. Not false and not true — unassessed
       is its own answer. */
    expect(v.cost.completeness.recorded).toBe(false);
    expect(v.cost.completeness.costComplete).toBeNull();

    const s = await submit(w, versionId);
    expect(s.status).toBe(409);
    expect(s.body.error.details.reason).toBe("COMPLETENESS_NOT_RECORDED");
    /* The fix is different from a gap, and the message says so. */
    expect(s.body.error.message).toMatch(/Calculate it again/);
  });

  test("an already-approved legacy version stays readable and approved", async () => {
    const w = await world();
    const r = await calc(w, [], COMPLETE);
    const versionId = r.body.versions[0].id;
    await submit(w, versionId);
    await approve(w, versionId);
    /* Its assessment is then removed, as a genuinely old version would have
       none. */
    await asLegacy(versionId, { $unset: { completeness: "" } });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === versionId);
    /* Approved output already published stays published — withdrawing a
       commercial answer Sales may have quoted would be a worse failure than
       an unassessed one. It is labelled, not revoked. */
    expect(v.status).toBe("APPROVED");
    expect(v.cost.completeness.recorded).toBe(false);
  });
});
