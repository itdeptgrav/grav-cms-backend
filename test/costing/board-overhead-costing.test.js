// test/costing/board-overhead-costing.test.js
//
// THE BOARD'S OVERHEAD RULE, MEETING A REAL COSTING.
//
// ── WHAT THIS MIGRATION MUST NOT HAVE CHANGED ───────────────────────────────
// The arithmetic. Overhead is still a percentage of a named subtotal, still
// synthesised by the engine as its own line, still ordered by the same basis
// graph. Given the same rate and basis, a costing produces the figure it
// always did — and the first test here is that claim stated as a number.
//
// ── AND WHAT IT DID CHANGE ──────────────────────────────────────────────────
// Where the rate comes from: an approved, effective-dated Board version
// resolved against the costing's own date, instead of two fields somebody
// could save. So a company that has not decided gets NO overhead line rather
// than a rate nobody approved, and a version can explain its own figure.
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
  seedSourceBacked, configureProduction, approveOverheadPolicy, EXPECTED, prepareForCosting } = require("./helpers/sourceBacked");

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

const newKey = () => `oh-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  const email = `oh-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "O", lastName: `C${n}`, email, biometricId: `OC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "O", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "O" });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "O Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* No overhead in this body — it is refused now, and that is its own test. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const SCEN = [{ key: "q500", quantity: "500", isPrimary: true }];

/** A company, a costed enquiry product, and whichever overhead rule is wanted. */
async function world({ overhead = {} } = {}) {
  const co = await company("Ovh");
  const me = await admin([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCEN, quantityUom: "Pieces" }, });
  /* The overhead rule goes in through the shared fixture, so this suite
     approves exactly one — a second approval on the same date is refused, and
     rightly. `overhead: null` is a company whose Board has not decided. */
  await configureProduction(co._id, { overhead });
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

const linesOf = (r) => Object.fromEntries(
  r.body.versions[0].cost.scenarios[0].lines.map((l) => [l.lineKey, l.totalMinor]),
);

/* ═══ 1 · THE ARITHMETIC IS UNCHANGED ═════════════════════════════════════ */

describe("percentage of basis, exactly as before", () => {
  test("12% of direct-plus-fixed is the figure it always was", async () => {
    /* Direct cost 10,354 a garment; 12% = 1,242 (the fixture's own EXPECTED,
       written before any of this existed and not adjusted for it). */
    const w = await world();
    const r = await calc(w);
    expect(r.status).toBe(201);
    const perUnit = r.body.versions[0].cost.scenarios[0].lines
      .find((l) => l.lineKey === "policy:overhead").perUnitMinor;
    expect(perUnit).toBe(EXPECTED.overheadPerGarmentMinor);
    expect(r.body.versions[0].cost.scenarios[0].unitCostMinor).toBe(EXPECTED.unitCostMinor);
  });

  test("the basis is half the decision, and changing it changes the money", async () => {
    /* The same rate on conversion cost only — labour and outside processes —
       is a different cost, and this is why the basis is approved rather than
       assumed. */
    const wide = await world({ overhead: { ratePercent: "12", basis: "DIRECT_PLUS_FIXED" } });
    const narrow = await world({ overhead: { ratePercent: "12", basis: "CONVERSION" } });
    const a = linesOf(await calc(wide))["policy:overhead"];
    const b = linesOf(await calc(narrow))["policy:overhead"];
    expect(a).toBeGreaterThan(b);
    /* 12% of the labour alone: 354 x 500 x 12% = 21,240. */
    expect(b).toBe(21240);
  });

  test("the line is still ordered by the same basis graph, after the direct costs", async () => {
    const w = await world();
    const r = await calc(w);
    const line = r.body.versions[0].cost.scenarios[0].lines.find((l) => l.lineKey === "policy:overhead");
    expect(line.behaviour).toBe("PERCENT_OF_BASIS");
    expect(line.basis).toBe("DIRECT_PLUS_FIXED");
    expect(line.category).toBe("OVERHEAD");
    /* And the engine reports what it was a percentage OF. */
    expect(line.basisAmountMinor).toBeGreaterThan(0);
    expect(line.totalMinor).toBe(Math.round(line.basisAmountMinor * 0.12));
  });

  test("a 0% rate the Board approved is applied as a rule, and comes to nil", async () => {
    /* A company that genuinely adds nothing may say so — and that is a
       decision, told apart from silence by the line existing at all. */
    const w = await world({ overhead: { ratePercent: "0", basis: "DIRECT_PLUS_FIXED" } });
    const r = await calc(w);
    expect(linesOf(r)["policy:overhead"]).toBe(0);
    expect(r.body.versions[0].cost.overheadProvenance.ratePercent).toBe("0");
  });
});

/* ═══ 2 · MISSING IS MISSING, NOT ZERO ════════════════════════════════════ */

describe("a company whose Board has not decided", () => {
  test("gets no overhead line at all — never a rate of nothing", async () => {
    const w = await world({ overhead: null });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(linesOf(r)["policy:overhead"]).toBeUndefined();
    expect(r.body.versions[0].cost.overheadProvenance).toBeUndefined();

    /* And the costing says so rather than looking finished. */
    expect(r.body.versions[0].cost.completeness.costComplete).toBe(false);
    const family = r.body.versions[0].cost.completeness.families.find((f) => f.key === "overhead");
    expect(family.state).not.toBe("RECORDED_ZERO");
  });

  test("a draft nobody approved is not a policy", async () => {
    const w = await world({ overhead: null });
    const boardPolicy = require("../../services/board/boardPolicy.service");
    await boardPolicy.createDraft(
      { companyId: w.co._id, actorId: "x", actorName: "X" },
      { policyKey: "OVERHEAD", overhead: { ratePercent: "12", basis: "DIRECT_PLUS_FIXED" } },
    );
    const r = await calc(w);
    /* Written is not approved. Applying it would be the whole point of the
       approval step going missing. */
    expect(linesOf(r)["policy:overhead"]).toBeUndefined();
  });

  test("a future-dated policy does not reach a costing made today", async () => {
    const w = await world({ overhead: { effectiveFrom: new Date("2035-01-01") } });
    const r = await calc(w);
    expect(linesOf(r)["policy:overhead"]).toBeUndefined();
  });
});

/* ═══ 3 · RESOLUTION BY THE COSTING'S OWN DATE ════════════════════════════ */

describe("the rule in force on the costing's date", () => {
  test("each date resolves to the version that was in force on it", async () => {
    const w = await world({ overhead: { ratePercent: "9", basis: "DIRECT_PLUS_FIXED", effectiveFrom: new Date("2026-01-01") } });
    await approveOverheadPolicy(w.co._id, {
      ratePercent: "20", basis: "DIRECT_PLUS_FIXED", effectiveFrom: new Date("2026-07-01"),
    });

    const march = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-03-01") });
    expect(march.policy.overheadRatePercent).toBe("9");
    const september = await policyService.getPolicy({ companyId: w.co._id }, { asOf: new Date("2026-09-01") });
    expect(september.policy.overheadRatePercent).toBe("20");
  });
});

/* ═══ 4 · WHAT IS FROZEN, AND THAT IT STAYS FROZEN ════════════════════════ */

describe("a frozen version explains its own overhead", () => {
  test("the decision, the rule, and what the percentage was applied to", async () => {
    const w = await world();
    const r = await calc(w);
    const oh = r.body.versions[0].cost.overheadProvenance;

    /* The Board's decision — identified so it can be found, copied so it can
       be checked without being found. */
    expect(oh.boardPolicyId).toBeTruthy();
    expect(oh.policyKey).toBe("OVERHEAD");
    expect(oh.policyEffectiveFrom).toBeTruthy();
    expect(oh.policyApprovedAt).toBeTruthy();
    expect(oh.policyApprovedByName).toBe("Board Fixture");

    /* The rule, both halves. */
    expect(oh.ratePercent).toBe("12");
    expect(oh.basis).toBe("DIRECT_PLUS_FIXED");

    /* ── AND THE ARITHMETIC ────────────────────────────────────────────
       `DIRECT_PLUS_FIXED` is a computed subtotal across every other line;
       without the amount it came to, "12% of direct plus fixed" cannot be
       re-derived a year later without recalculating the whole costing. */
    const [s] = oh.scenarios;
    expect(s.scenarioKey).toBe("q500");
    expect(s.basisAmountMinor).toBeGreaterThan(0);
    expect(s.overheadMinor).toBe(Math.round(s.basisAmountMinor * 0.12));
    expect(s.perUnitMinor).toBe(EXPECTED.overheadPerGarmentMinor);
  });

  test("a new Board policy does not restate a version frozen before it", async () => {
    const w = await world();
    const before = await calc(w);
    const frozenAmount = linesOf(before)["policy:overhead"];

    /* The Board doubles the rate, effective today. */
    await approveOverheadPolicy(w.co._id, {
      ratePercent: "24", basis: "DIRECT_PLUS_FIXED", effectiveFrom: new Date(Date.now() - 1000),
    });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey === "policy:overhead").totalMinor)
      .toBe(frozenAmount);
    expect(v.cost.overheadProvenance.ratePercent).toBe("12");

    /* Not because anything protects the version — because it copied. */
    const stored = await CostingVersion.findById(v.id).lean();
    expect(stored.overheadProvenance.ratePercent).toBe("12");
    expect(stored.policySnapshot.overheadRatePercent).toBe("12");
  });

  test("a backdated approval cannot restate it either", async () => {
    const w = await world();
    const before = await calc(w);
    const frozenAmount = linesOf(before)["policy:overhead"];
    await approveOverheadPolicy(w.co._id, {
      ratePercent: "30", basis: "DIRECT", effectiveFrom: new Date("2020-01-01"),
    });
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey === "policy:overhead").totalMinor)
      .toBe(frozenAmount);
    expect(v.cost.overheadProvenance.basis).toBe("DIRECT_PLUS_FIXED");
  });
});

/* ═══ 5 · THE LEGACY WRITER ═══════════════════════════════════════════════ */

describe("the costing policy is no longer a way to set overhead", () => {
  const putPolicy = (me, co, body) =>
    call("/policy/current", { method: "PUT", token: me.token, company: co._id, body });

  test("setting a rate through the legacy endpoint is refused by name", async () => {
    const co = await company("Moved");
    const me = await admin([co]);
    const r = await putPolicy(me, co, {
      ...POLICY, overheadBasis: "DIRECT_PLUS_FIXED", overheadRatePercent: "12",
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("OVERHEAD_POLICY_MOVED");
    expect(r.body.error.details.field).toBe("overheadBasis");
    expect(r.body.error.details.ownedBy).toBe("BOARD");

    /* Nothing was written — not even the rest of the request. */
    expect(await CostingPolicy.findOne({ companyId: co._id }).lean()).toBeNull();
  });

  test("a rate alone is refused too, so there is no half-open path", async () => {
    const co = await company("MovedHalf");
    const me = await admin([co]);
    const r = await putPolicy(me, co, { ...POLICY, overheadRatePercent: "9" });
    expect(r.status).toBe(409);
    expect(r.body.error.details.field).toBe("overheadRatePercent");
  });

  test("a legacy rate is readable, marked uneditable, applied to nothing, and clearable", async () => {
    const co = await company("Legacy");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    /* Written the way history was: straight to the collection, because the
       route that put it there is closed. */
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { overheadBasis: "DIRECT_PLUS_FIXED", overheadRatePercent: "18" } },
    );

    const back = await call("/policy/current", { token: me.token, company: co._id });
    expect(back.body.policy.overheadRatePercent).toBe("18");
    expect(back.body.policy.overheadPolicy.editable).toBe(false);
    expect(back.body.policy.overheadPolicy.legacyRatePresent).toBe(true);
    expect(back.body.policy.overheadPolicy.boardPolicyInForce).toBe(false);

    /* ── AND IT REACHES NO CALCULATION ─────────────────────────────────
       An unapproved value applied under a Board-governed family would be
       that value being treated as Board-approved. */
    const resolved = await policyService.getPolicy({ companyId: co._id }, {});
    expect(resolved.policy.overheadRatePercent).toBeUndefined();
    expect(resolved.policy.legacyOverheadRatePercent).toBe("18");

    /* Clearing is the one write still accepted. */
    const cleared = await putPolicy(me, co, {
      ...POLICY, revision: back.body.revision, overheadBasis: null, overheadRatePercent: null,
    });
    expect(cleared.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: co._id }).lean();
    expect(doc.overheadRatePercent).toBeUndefined();
  });

  test("a save of an unrelated field does not wipe a legacy rate", async () => {
    /* ── THE QUIET WAY THIS COULD HAVE GONE WRONG ──────────────────────
       `getPolicy` stopped projecting the legacy fields into the calculation.
       If `savePolicy` had merged from that projection, every save of an
       unrelated setting would have `$unset` them — silently destroying the
       data kept to explain old frozen versions. */
    const co = await company("Preserve");
    const me = await admin([co]);
    await putPolicy(me, co, POLICY);
    await CostingPolicy.collection.updateOne(
      { companyId: co._id },
      { $set: { overheadBasis: "DIRECT", overheadRatePercent: "7" } },
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
    expect(doc.overheadRatePercent).toBe("7");
    expect(doc.overheadBasis).toBe("DIRECT");
    expect(doc.sellingPriceIncrementMinor).toBe(500);
  });

  test("a historical version keeps its own snapshot meaning", async () => {
    /* A version frozen before the Board took the rate over carries
       `policySnapshot.overheadRatePercent` and no provenance. It must stay
       readable, and must NOT be re-presented as a Board decision. */
    const w = await world();
    const r = await calc(w);
    const id = r.body.versions[0].id;
    await CostingVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(id)) },
      { $unset: { overheadProvenance: "" } },
    );
    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === id);
    expect(v.cost.overheadProvenance).toBeUndefined();
    expect(v.cost.policySnapshot?.overheadRatePercent ?? v.cost.scenarios[0].lines
      .find((l) => l.lineKey === "policy:overhead")).toBeTruthy();
  });
});
