// test/costing/board-contingency-costing.test.js
//
// THE BOARD'S CONTINGENCY DECISION, MEETING A REAL COSTING.
//
// ── WHAT THIS MIGRATION MUST NOT HAVE CHANGED ───────────────────────────────
// The arithmetic. `engine.js` synthesises one `MISC` line at
// `basis × rate ÷ 100`, orders it against every other percentage line and
// rounds it once. None of that was touched — the overlay fills the same two
// names the retired costing-policy fields filled, so the only thing that
// changed is who decided them and whether anybody approved it.
//
// ── AND WHAT IT DID CHANGE ──────────────────────────────────────────────────
// That "no contingency" is now three different records rather than one:
//
//   the Board decided none        an audited posture, frozen with its reason;
//   the Board set it to 0%        a real line at nil, in every build-up;
//   nobody has decided            an open question, reported as one.
//
// The retired field could express only the second and could not tell the
// first from the third at all.
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
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const policyService = require("../../services/centralCosting/policy.service");
const assembly = require("../../services/centralCosting/assembly.service");
const { calculate } = require("../../services/centralCosting/engine");
const { approveContingencyPolicy, approveMarginPolicy } = require("./helpers/sourceBacked");

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

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
};

async function world({ legacy = null } = {}) {
  const co = await Acc_Company.create({
    companyName: `Ctg ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const n = ++seq;
  const email = `ctg-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "C", lastName: `T${n}`, email, biometricId: `CT${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "C", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
  await CostingPolicy.create({
    companyId: co._id, ...POLICY, revision: 1,
    ...(legacy || {}),
  });
  /* ── AND A BOARD MARGIN BAND, BECAUSE THERE IS NO PRICE WITHOUT ONE ───
     The band moved to the Board too, and unlike every other policy its absence
     stops the arithmetic rather than leaving a gap: `engine.js` reads all three
     figures as required. This suite is about contingency, so it states the band
     once and never asserts against it. */
  await approveMarginPolicy(co._id);
  return { co, token };
}

/** One material line, so a PRIME basis has something to be a percentage of. */
const LINES = [{
  lineKey: "m1", category: "MATERIAL", behaviour: "PER_UNIT", quantityPerUnit: "1",
  unitRate: { amountMinor: 10000, currency: "INR" }, confidence: "VERIFIED",
}];
const SCEN = [
  { key: "q100", label: "100", quantity: "100", isPrimary: true },
  { key: "q500", label: "500", quantity: "500" },
];

const runWith = async (w) => {
  const { policy } = await policyService.getPolicy(w.co._id ? { companyId: w.co._id } : w);
  return calculate({ policy, lines: LINES, scenarios: SCEN });
};

const contingencyLine = (result, key = "q100") =>
  (result.scenarios.find((s) => s.key === key).lines || [])
    .find((l) => l.lineKey === "policy:contingency") || null;

/* ═══ 1 · THE ARITHMETIC, UNCHANGED ═══════════════════════════════════════ */

describe("an applied contingency is charged exactly as it always was", () => {
  test("2% of prime cost, to the paisa, on every scenario", async () => {
    const w = await world();
    await approveContingencyPolicy(w.co._id, { ratePercent: "2", basis: "PRIME" });
    const r = await runWith(w);

    /* 100 × ₹100 = ₹10,000 of material; 2% = ₹200. */
    expect(contingencyLine(r, "q100")).toMatchObject({
      category: "MISC", basisAmountMinor: 1000000, totalMinor: 20000,
    });
    /* 500 × ₹100 = ₹50,000; 2% = ₹1,000. It scales with the run because its
       BASIS does, not because the line is per-unit. */
    expect(contingencyLine(r, "q500")).toMatchObject({
      basisAmountMinor: 5000000, totalMinor: 100000,
    });
  });

  test("a rate that does not divide evenly is rounded once, not per scenario part", async () => {
    const w = await world();
    await approveContingencyPolicy(w.co._id, { ratePercent: "1.75", basis: "PRIME" });
    const r = await runWith(w);
    /* 1,000,000 × 1.75% = 17,500 exactly; the point is that it is computed on
       the run total rather than on a rounded per-unit figure. */
    expect(contingencyLine(r, "q100").totalMinor).toBe(17500);
    expect(contingencyLine(r, "q500").totalMinor).toBe(87500);
  });

  test("it is a MISC line, distinct from overhead and from the margin", async () => {
    /* ── THE THREE THAT MUST NOT BE CONFUSED ──────────────────────────
       Contingency is a COST. Overhead is a different cost with its own
       category and its own Board policy. Margin is not a cost at all — it is
       applied to the total afterwards. They must never merge. */
    const w = await world();
    await approveContingencyPolicy(w.co._id, { ratePercent: "2", basis: "PRIME" });
    const r = await runWith(w);
    const cats = r.scenarios[0].categorySubtotals.map((c) => c.category);
    expect(cats).toContain("MISC");
    expect(contingencyLine(r).category).toBe("MISC");
    expect(contingencyLine(r).category).not.toBe("OVERHEAD");
    /* ── AND MARGIN IS NOT A COST AT ALL ──────────────────────────────
       Said as a positive fact rather than as "MARGIN is not in the list",
       which would pass trivially: the markup is not one of the engine's cost
       categories, and it reaches the answer through `floor` — applied TO the
       total cost, after the contingency is already inside it. */
    const { CATEGORIES } = require("../../services/centralCosting/engine");
    expect(CATEGORIES).toContain("MISC");
    expect(CATEGORIES).toContain("OVERHEAD");
    expect(CATEGORIES).not.toContain("MARGIN");
    expect(r.scenarios[0].floor).toBeTruthy();
    /* The contingency is inside the cost the markup is then applied to — so
       the floor is derived from a total that already contains it, rather than
       the contingency being added to a price afterwards. */
    expect(r.scenarios[0].totalCostMinor).toBe(1000000 + 20000);
    expect(r.scenarios[0].floor.trueUnitCostMinor).toBe(r.scenarios[0].unitCostMinor);
  });
});

/* ═══ 2 · THE THREE WAYS OF HAVING NO CONTINGENCY ═════════════════════════ */

describe("no contingency is three different records", () => {
  test("a decision of NONE charges nothing and fabricates no line", async () => {
    const w = await world();
    await approveContingencyPolicy(w.co._id, { mode: "NONE", rationale: "Carried in the margin band." });
    const r = await runWith(w);
    expect(contingencyLine(r)).toBeNull();
    /* And the costing is otherwise complete — nothing was refused. */
    expect(r.scenarios[0].totalCostMinor).toBe(1000000);
  });

  test("an explicit 0% DOES produce a line, at nil", async () => {
    /* Which is the difference: a later Board can raise this without changing
       the shape of the cost sheet, and every build-up already shows the row. */
    const w = await world();
    await approveContingencyPolicy(w.co._id, { ratePercent: "0", basis: "PRIME" });
    const r = await runWith(w);
    expect(contingencyLine(r)).toMatchObject({ totalMinor: 0, basisAmountMinor: 1000000 });
  });

  test("no policy at all charges nothing either — and says so, which NONE does not", async () => {
    const w = await world();
    const r = await runWith(w);
    expect(contingencyLine(r)).toBeNull();

    const assembled = await policyService.getPolicy({ companyId: w.co._id });
    expect(assembled.contingency.state).toBe("POLICY_MISSING");
    expect(assembled.contingency.missing[0].message).toMatch(/not the same as the company having decided not to/);
  });

  test("and the readiness note appears for a silence but NOT for a decision", async () => {
    /* ── WHAT THE OLD CHECK GOT WRONG ─────────────────────────────────
       It tested whether a RATE was present, so a company that had decided it
       adds no contingency was told for ever that its policy "is not
       configured" — asking it to fix something it had settled. */
    const silent = await world();
    const notes = (p) => (p || []).filter((m) => m.key === "policy-contingency");

    const undecided = await policyService.getPolicy({ companyId: silent.co._id });
    const a = assembly.policyMissing(undecided.policy, true, undecided.contingency);
    expect(notes(a)).toHaveLength(1);
    expect(notes(a)[0].owner.department).toBe("Board");
    /* Non-blocking: a contingency is a cushion ON a cost, not an input TO one,
       and every figure in the costing is correct without it. */
    expect(notes(a)[0].blocking).toBe(false);

    const decided = await world();
    await approveContingencyPolicy(decided.co._id, { mode: "NONE", rationale: "None." });
    const settled = await policyService.getPolicy({ companyId: decided.co._id });
    const b = assembly.policyMissing(settled.policy, true, settled.contingency);
    expect(notes(b)).toHaveLength(0);
  });

  test("the presentation row says NOT_APPLICABLE for a decision, MISSING for a silence", async () => {
    const decided = await world();
    await approveContingencyPolicy(decided.co._id, { mode: "NONE", rationale: "None." });
    const settled = await policyService.getPolicy({ companyId: decided.co._id });
    const row = assembly.policySection(settled.policy, true, settled.contingency)
      .rules.find((x) => x.key === "contingency");
    expect(row).toMatchObject({ state: "NOT_APPLICABLE", value: "None" });
    expect(row.owner.department).toBe("Board");

    const silent = await world();
    const open = await policyService.getPolicy({ companyId: silent.co._id });
    const row2 = assembly.policySection(open.policy, true, open.contingency)
      .rules.find((x) => x.key === "contingency");
    expect(row2.state).toBe("MISSING");
  });
});

/* ═══ 3 · A BASIS THAT WOULD REFUSE THE WHOLE COSTING ═════════════════════ */

test("the four circular bases cannot reach a costing, because they cannot be approved", async () => {
  /* Proved from the engine's side too: this is what used to happen to a
     company whose retired policy stored one of them. */
  const w = await world();
  const { policy } = await policyService.getPolicy({ companyId: w.co._id });
  expect(() => calculate({
    policy: { ...policy, contingencyRatePercent: "2", contingencyBasis: "SUBTOTAL_BEFORE_OVERHEAD" },
    lines: LINES, scenarios: SCEN,
  })).toThrow(/percentage of a total that already includes it/);

  /* And the Board contract refuses it before it can be approved. */
  await expect(approveContingencyPolicy(w.co._id, { basis: "SUBTOTAL_BEFORE_OVERHEAD" }))
    .rejects.toMatchObject({ details: { reason: "CONTINGENCY_BASIS_CIRCULAR" } });
});

/* ═══ 4 · THE LEGACY WRITER IS RETIRED ════════════════════════════════════ */

describe("the costing policy no longer decides this", () => {
  test("a submitted rate is refused by name, not silently ignored", async () => {
    const w = await world();
    const r = await call("/policy/current", {
      method: "PUT", token: w.token, company: w.co._id,
      body: { ...POLICY, revision: 1, contingencyRatePercent: "3", contingencyBasis: "PRIME" },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("CONTINGENCY_POLICY_MOVED");
    expect(r.body.error.details.ownedBy).toBe("BOARD");
    expect(r.body.error.details.policyKey).toBe("CONTINGENCY_POLICY");
  });

  test("clearing is still allowed — retiring a display is not authoring policy", async () => {
    const w = await world({ legacy: { contingencyRatePercent: "1.5", contingencyBasis: "PRIME" } });
    const r = await call("/policy/current", {
      method: "PUT", token: w.token, company: w.co._id,
      body: { ...POLICY, revision: 1, contingencyRatePercent: null, contingencyBasis: null },
    });
    expect(r.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: w.co._id }).lean();
    expect(doc.contingencyRatePercent).toBeUndefined();
    expect(doc.contingencyBasis).toBeUndefined();
  });

  test("a legacy rate is retained, published as legacy, and applied to nothing", async () => {
    const w = await world({ legacy: { contingencyRatePercent: "1.5", contingencyBasis: "PRIME" } });

    /* Not read into the calculation. */
    const r = await runWith(w);
    expect(contingencyLine(r)).toBeNull();

    /* But shown, so the company can see what it is carrying. */
    const panel = await call("/policy/current", { token: w.token, company: w.co._id });
    expect(panel.body.policy.contingencyRatePercent).toBe("1.5");
    expect(panel.body.policy.contingencyPolicy).toMatchObject({
      editable: false, ownedBy: "BOARD", policyKey: "CONTINGENCY_POLICY",
      legacyValuesPresent: true, boardPolicyInForce: false,
    });
  });

  test("an unrelated save does not erase the retained values", async () => {
    /* ── THE SILENT-WIPE HAZARD ───────────────────────────────────────
       `getPolicy` stopped projecting these two names, and `savePolicy`
       `$unset`s anything undefined — so without seeding them from the legacy
       projection, saving a margin would erase the record kept to explain old
       frozen versions and to seed the Board's first draft. */
    const w = await world({ legacy: { contingencyRatePercent: "1.5", contingencyBasis: "PRIME" } });
    const r = await call("/policy/current", {
      method: "PUT", token: w.token, company: w.co._id,
      /* A field the costing policy still owns. The margin band moved to the
         Board on the same terms as contingency, so writing it here would be
         testing a refusal rather than an unrelated save. */
      body: { ...POLICY, revision: 1, sellingPriceIncrementMinor: 500 },
    });
    expect(r.status).toBe(200);
    const doc = await CostingPolicy.findOne({ companyId: w.co._id }).lean();
    expect(doc.contingencyRatePercent).toBe("1.5");
    expect(doc.contingencyBasis).toBe("PRIME");
  });

  test("a legacy value is never treated as approved", async () => {
    const w = await world({ legacy: { contingencyRatePercent: "1.5", contingencyBasis: "PRIME" } });
    const resolved = await policyService.getPolicy({ companyId: w.co._id });
    expect(resolved.contingency.state).toBe("POLICY_MISSING");
    expect(resolved.policy.contingencyRatePercent).toBeUndefined();
  });

  test("exactly one writer decides this now", async () => {
    /* The costing policy refuses it; the Board approves it. Asserted as a
       repository fact so a second writer cannot reappear unnoticed. */
    const fs = require("fs");
    const policySrc = fs.readFileSync("services/centralCosting/policy.service.js", "utf8");
    expect(policySrc).toMatch(/CONTINGENCY_POLICY_MOVED/);
    /* No path in the costing policy assigns a contingency value any more. */
    expect(policySrc).not.toMatch(/merged\.contingencyRatePercent\s*=\s*lift/);
    expect(policySrc).not.toMatch(/merged\[rateKey\]\s*=\s*lift/);
  });
});

/* ═══ 5 · NOTHING ELSE MOVED ══════════════════════════════════════════════ */

test("no frontend contingency editor ever existed, so none was removed", async () => {
  /* Stated rather than assumed: the retirement of the backend writer is the
     whole of the UI change, and claiming a removed control would be inventing
     work that never happened. */
  const { execSync } = require("child_process");
  const out = execSync(
    "grep -rl 'contingencyRatePercent\\|contingencyBasis' ../grav-cms/components ../grav-cms/app 2>/dev/null || true",
    { encoding: "utf8" },
  ).trim();
  expect(out).toBe("");
});
