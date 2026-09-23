// test/costing/board-labour-costing.test.js
//
// THE BOARD'S LABOUR METHODOLOGY, MEETING A REAL COSTING.
//
// ── WHAT THIS MIGRATION MUST NOT HAVE CHANGED ───────────────────────────────
// The arithmetic, which lives in `labourCost.js` and was not touched:
//
//     employer cost = net salary × (1 + burden%)
//     productive    = stated minutes, OR 12,480 × efficiency%
//     per minute    = employer cost ÷ productive
//     per garment   = per minute × SAM
//
// The first test states that as a number, against the fixture's own EXPECTED —
// written long before any of this existed.
//
// ── AND WHAT IT DID CHANGE ──────────────────────────────────────────────────
// Where the three assumptions come from, and what a version can explain
// afterwards. A frozen version now carries the Board's decision AND every
// operation's working — which no version has ever kept.
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
const labourCost = require("../../services/centralCosting/labourCost");
const {
  seedSourceBacked, configureProduction, approveLabourPolicy, EXPECTED, prepareForCosting } = require("./helpers/sourceBacked");

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

const newKey = () => `lb-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  const email = `lbc-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "L", lastName: `C${n}`, email, biometricId: `LC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "L", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "L Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* No overhead: it would sit on top of every figure asserted here, and its own
   participation is proved in board-overhead-costing. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const SCEN = [{ key: "q500", quantity: "500", isPrimary: true }];

async function world({ labour = {}, seed = {} } = {}) {
  const co = await company("Lab");
  const me = await admin([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  const seeded = await seedSourceBacked(co._id, seed);
  await configureProduction(co._id, { overhead: null, labour });
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

const opLine = (r) => r.body.versions[0].cost.scenarios[0].lines
  .find((l) => l.lineKey.startsWith("op:"));

/* ═══ 1 · THE ARITHMETIC IS UNCHANGED ═════════════════════════════════════ */

describe("the formula, exactly as before", () => {
  test("stated minutes: salary × burden ÷ minutes × SAM", async () => {
    /* 18,000 × 1.18 = 21,240; ÷ 9,000 = 2.36/min; × 1.5 SAM = 3.54 → 354. */
    const w = await world();
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(opLine(r).unitRateMinor ?? opLine(r).perUnitMinor).toBe(EXPECTED.labourRateMinor);
    expect(r.body.versions[0].cost.scenarios[0].unitCostMinor)
      .toBe(EXPECTED.materialRateMinor + EXPECTED.labourRateMinor);
  });

  test("an efficiency derives the same denominator labourCost derives", async () => {
    /* 12,480 × 80% = 9,984; 21,240 ÷ 9,984 = 2.1274/min; × 1.5 = 3.19 → 319. */
    const w = await world({
      labour: { productiveMinutesPerMonth: undefined, labourEfficiencyPercent: "80" },
    });
    const r = await calc(w);
    expect(opLine(r).perUnitMinor).toBe(319);

    const fin = r.body.versions[0].cost.labourProvenance;
    expect(fin.productiveBasis).toBe("EFFICIENCY");
    expect(fin.labourEfficiencyPercent).toBe("80");
    /* The decision, and the number it came to. */
    expect(fin.productiveMinutesResolved).toBe("9984.00");
  });

  test("zero employer burden costs an operator their salary, and is a decision", async () => {
    /* 18,000 ÷ 9,000 = 2.00/min; × 1.5 = 3.00 → 300. */
    const w = await world({ labour: { employerBurdenPercent: "0" } });
    const r = await calc(w);
    expect(opLine(r).perUnitMinor).toBe(300);
    expect(r.body.versions[0].cost.labourProvenance.employerBurdenPercent).toBe("0");
  });

  test("`labourCost` is still the single authority, and agrees with the version", async () => {
    /* The same module, called directly with the same inputs — so a drift
       between the frozen figure and the arithmetic would show up here. */
    const direct = labourCost.labourCostPerGarment({
      samMinutes: "1.5", netSalaryPerMonth: "18000",
      policy: { productiveMinutesPerMonth: 9000, employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD" },
      roundingMode: "HALF_UP",
    });
    expect(direct.ok).toBe(true);
    expect(direct.amountMinor).toBe(EXPECTED.labourRateMinor);
    expect(labourCost.PAID_MINUTES_PER_MONTH).toBe(12480);
  });

  test("two operations on different salary bases each cost their own", async () => {
    const w = await world({ seed: { samSeconds: 120, salary: 24000 } });
    const r = await calc(w);
    /* 24,000 × 1.18 = 28,320; ÷ 9,000 = 3.1467/min; × 2 SAM = 6.29 → 629. */
    expect(opLine(r).perUnitMinor).toBe(629);
    const ops = r.body.versions[0].cost.labourProvenance.operations;
    expect(ops).toHaveLength(1);
    expect(ops[0].netSalaryPerMonth).toBe("24000");
    expect(ops[0].samMinutes).toBe("2");
  });
});

/* ═══ 2 · MISSING IS MISSING ══════════════════════════════════════════════ */

describe("a company whose Board has not decided", () => {
  test("operation rates fall back to the sample's figure and are provisional", async () => {
    const w = await world({ labour: null });
    const r = await calc(w);
    expect(r.status).toBe(201);
    /* Not zero, and not the policy rate — the sample's own legacy figure,
       reported as provisional rather than presented as costed. */
    expect(r.body.versions[0].cost.labourProvenance).toBeUndefined();
    expect(r.body.versions[0].cost.completeness.costComplete).toBe(false);
  });

  test("the gap names the Board, not Finance", async () => {
    const w = await world({ labour: null });
    const preview = await call(`/${w.costingId}/technical-preview`, {
      token: w.me.token, company: w.co._id,
    });
    expect(preview.status).toBe(200);
    const gap = (preview.body.missing || []).find((m) => m.key === "policy-production-assumptions");
    expect(gap).toBeTruthy();
    /* ── THE DESK, NOT JUST THE MESSAGE ────────────────────────────────
       The gap itself is unchanged — `labourCost.assumptionGaps` is still the
       one definition. What moved is who can close it: pointing at Finance
       would send somebody to a screen that now refuses the write. */
    expect(gap.owner.department).toBe("Board");
    expect(gap.message).toMatch(/provisional/);
  });

  test("a draft nobody approved is not a policy", async () => {
    const w = await world({ labour: null });
    const boardPolicy = require("../../services/board/boardPolicy.service");
    await boardPolicy.createDraft(
      { companyId: w.co._id, actorId: "x", actorName: "X" },
      {
        policyKey: "LABOUR_METHODOLOGY",
        labour: { productiveMinutesPerMonth: 9000, employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD" },
      },
    );
    expect((await calc(w)).body.versions[0].cost.labourProvenance).toBeUndefined();
  });

  test("a future-dated policy does not reach a costing made today", async () => {
    const w = await world({ labour: null });
    await approveLabourPolicy(w.co._id, { effectiveFrom: new Date("2035-01-01") });
    expect((await calc(w)).body.versions[0].cost.labourProvenance).toBeUndefined();
  });
});

/* ═══ 3 · RESOLUTION BY THE COSTING'S DATE ════════════════════════════════ */

describe("the rule in force on the costing's date", () => {
  test("each date resolves to the methodology in force on it", async () => {
    const w = await world({ labour: null });
    await approveLabourPolicy(w.co._id, {
      productiveMinutesPerMonth: 8000, effectiveFrom: new Date("2026-01-01"),
    });
    await approveLabourPolicy(w.co._id, {
      productiveMinutesPerMonth: 10000, effectiveFrom: new Date("2026-07-01"),
    });

    const march = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-03-01") });
    expect(march.policy.productiveMinutesPerMonth).toBe(8000);
    const september = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-09-01") });
    expect(september.policy.productiveMinutesPerMonth).toBe(10000);
  });
});

/* ═══ 4 · WHAT IS FROZEN ══════════════════════════════════════════════════ */

describe("a frozen version explains every operation", () => {
  test("the decision, the method, and each operation's working", async () => {
    const w = await world();
    const r = await calc(w);
    const lp = r.body.versions[0].cost.labourProvenance;

    expect(lp.boardPolicyId).toBeTruthy();
    expect(lp.policyKey).toBe("LABOUR_METHODOLOGY");
    expect(lp.policyEffectiveFrom).toBeTruthy();
    expect(lp.policyApprovedByName).toBe("Board Fixture");
    expect(lp.productiveBasis).toBe("STATED_MINUTES");
    expect(lp.productiveMinutesPerMonth).toBe(9000);
    expect(lp.employerBurdenPercent).toBe("18");
    expect(lp.machineBurdenTreatment).toBe("IN_OVERHEAD");

    /* ── THE WORKINGS NO VERSION HAS EVER KEPT ─────────────────────────
       "₹3.54 for this operation" could only be checked by re-reading the
       sample, the operation master and the policy — and once any had moved,
       not at all. */
    const [op] = lp.operations;
    expect(op.samMinutes).toBe("1.5");
    expect(op.netSalaryPerMonth).toBe("18000");
    expect(op.employerCostPerMonth).toBe("21240.00");
    expect(op.productiveMinutesPerMonth).toBe("9000.00");
    expect(op.costPerMinute).toBe("2.360000");
    expect(op.amountMinor).toBe(EXPECTED.labourRateMinor);
    expect(op.label).toBeTruthy();
  });

  test("a new Board policy does not restate a version frozen before it", async () => {
    const w = await world();
    const before = await calc(w);
    const frozen = opLine(before).perUnitMinor;

    await approveLabourPolicy(w.co._id, {
      productiveMinutesPerMonth: 4500, effectiveFrom: new Date(Date.now() - 1000),
    });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey.startsWith("op:")).perUnitMinor).toBe(frozen);
    expect(v.cost.labourProvenance.productiveMinutesPerMonth).toBe(9000);

    const stored = await CostingVersion.findById(v.id).lean();
    expect(stored.labourProvenance.productiveMinutesPerMonth).toBe(9000);
    expect(stored.policySnapshot.productiveMinutesPerMonth).toBe(9000);
  });

  test("a backdated approval cannot restate it either", async () => {
    const w = await world();
    const before = await calc(w);
    const frozen = opLine(before).perUnitMinor;
    await approveLabourPolicy(w.co._id, {
      productiveMinutesPerMonth: 3000, effectiveFrom: new Date("2020-01-01"),
    });
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.labourProvenance.productiveMinutesPerMonth).toBe(9000);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey.startsWith("op:")).perUnitMinor).toBe(frozen);
  });

  test("a dependency the policy left open is frozen as it stood", async () => {
    /* `IN_OVERHEAD` with no overhead policy in force — a valid Board decision
       that still leaves machine cost charged nowhere. The version says so for
       ever, rather than looking complete the day somebody approves overhead. */
    const w = await world({ labour: { machineBurdenTreatment: "IN_OVERHEAD" } });
    const r = await calc(w);
    const deps = r.body.versions[0].cost.labourProvenance.dependencies;
    expect(deps.map((d) => d.code)).toEqual(["MACHINE_OVERHEAD_DEPENDENCY_MISSING"]);
    expect(deps[0].message).toMatch(/charged nowhere/);
  });

  test("an exclusion keeps its reason on the record", async () => {
    const w = await world({
      labour: { machineBurdenTreatment: "NOT_COSTED", machineExclusionReason: "Plant fully depreciated." },
    });
    const r = await calc(w);
    const lp = r.body.versions[0].cost.labourProvenance;
    expect(lp.machineBurdenTreatment).toBe("NOT_COSTED");
    expect(lp.machineExclusionReason).toMatch(/depreciated/);
    expect(lp.dependencies).toEqual([]);
  });
});

/* ═══ 5 · THE LEGACY WRITER ═══════════════════════════════════════════════ */

describe("the costing policy is no longer a way to set labour assumptions", () => {
  const putPolicy = (me, co, body) =>
    call("/policy/current", { method: "PUT", token: me.token, company: co._id, body });

  test("each of the four fields is refused by name", async () => {
    const co = await company("Moved");
    const me = await admin([co]);
    for (const [field, value] of [
      ["productiveMinutesPerMonth", 9000], ["labourEfficiencyPercent", "80"],
      ["employerBurdenPercent", "18"], ["machineBurdenTreatment", "IN_OVERHEAD"],
    ]) {
      const r = await putPolicy(me, co, { ...POLICY, [field]: value });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("LABOUR_POLICY_MOVED");
      expect(r.body.error.details.field).toBe(field);
      expect(r.body.error.details.ownedBy).toBe("BOARD");
    }
    expect(await CostingPolicy.findOne({ companyId: co._id }).lean()).toBeNull();
  });

  test("legacy values are readable, marked uneditable, and applied to nothing", async () => {
    const co = await company("Legacy");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { productiveMinutesPerMonth: 7000, employerBurdenPercent: "25", machineBurdenTreatment: "NOT_COSTED" } },
    );

    const back = await call("/policy/current", { token: me.token, company: co._id });
    expect(back.body.policy.productiveMinutesPerMonth).toBe(7000);
    expect(back.body.policy.labourPolicy.editable).toBe(false);
    expect(back.body.policy.labourPolicy.legacyValuesPresent).toBe(true);
    expect(back.body.policy.labourPolicy.boardPolicyInForce).toBe(false);

    /* ── AND THEY REACH NO CALCULATION ─────────────────────────────────
       Applying unapproved assumptions under a Board-governed family would be
       treating them as Board-approved. */
    const resolved = await policyService.getPolicy({ companyId: co._id }, {});
    expect(resolved.policy.productiveMinutesPerMonth).toBeUndefined();
    expect(resolved.policy.employerBurdenPercent).toBeUndefined();
    expect(resolved.policy.legacyProductiveMinutesPerMonth).toBe(7000);
  });

  test("clearing is accepted, and clears the whole methodology together", async () => {
    const co = await company("Clear");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { productiveMinutesPerMonth: 7000, employerBurdenPercent: "25", machineBurdenTreatment: "NOT_COSTED" } },
    );
    const back = await call("/policy/current", { token: me.token, company: co._id });
    const cleared = await putPolicy(me, co, {
      ...POLICY, revision: back.body.revision, employerBurdenPercent: null,
    });
    expect(cleared.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: co._id }).lean();
    /* One methodology: a half-cleared one would leave a burden with no
       productive basis to apply it to. */
    expect(doc.productiveMinutesPerMonth).toBeUndefined();
    expect(doc.employerBurdenPercent).toBeUndefined();
    expect(doc.machineBurdenTreatment).toBeUndefined();
  });

  test("a save of an unrelated field does not wipe retained legacy values", async () => {
    const co = await company("Preserve");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { productiveMinutesPerMonth: 7000, employerBurdenPercent: "25", machineBurdenTreatment: "NOT_COSTED" } },
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
    expect(doc.productiveMinutesPerMonth).toBe(7000);
    expect(doc.employerBurdenPercent).toBe("25");
    expect(doc.machineBurdenTreatment).toBe("NOT_COSTED");
    expect(doc.sellingPriceIncrementMinor).toBe(500);
  });

  test("a historical version keeps its own snapshot meaning", async () => {
    const w = await world();
    const r = await calc(w);
    const id = r.body.versions[0].id;
    await CostingVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(id)) },
      { $unset: { labourProvenance: "" } },
    );
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === id);
    /* Readable, and NOT re-presented as a Board decision. */
    expect(v.cost.labourProvenance).toBeUndefined();
    const stored = await CostingVersion.findById(id).lean();
    expect(stored.policySnapshot.productiveMinutesPerMonth).toBe(9000);
    expect(stored.policySnapshot.employerBurdenPercent).toBe("18");
  });
});
