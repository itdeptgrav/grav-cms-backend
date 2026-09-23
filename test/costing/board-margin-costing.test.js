// test/costing/board-margin-costing.test.js
//
// THE COMPANY'S PRICING FLOOR, MEETING A REAL COSTING.
//
// ── WHAT THIS REPLACED, AND WHY THE NUMBER MOVED ────────────────────────────
// `engine.js` used to solve three price breaks as `cost / (1 - margin)`.
// Management replaced that with one decision: a markup on the true cost,
// producing one floor. On a ₹500 cost at 20% the two differ by ₹25 —
//
//     markup  →  500 × 1.20        = ₹600     ← what this calculates
//     margin  →  500 ÷ (1 − 0.20)  = ₹625     ← what it used to
//
// — so this suite asserts the ₹600 and asserts AGAINST the ₹625 by name. A
// regression that reinstated the old arithmetic would still produce a
// plausible price, and only the second assertion catches it.
//
// ── AND WHAT DID NOT CHANGE ─────────────────────────────────────────────────
// That a company with no approved pricing policy is REFUSED rather than priced.
// This is the only policy whose absence would otherwise produce a number
// instead of a gap.
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
const marginPolicy = require("../../services/centralCosting/marginPolicy.service");
const { calculate } = require("../../services/centralCosting/engine");
const { approveMarginPolicy, seedHistoricalBandPolicy } = require("./helpers/sourceBacked");

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
    companyName: `Mgn ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const n = ++seq;
  const email = `mgn-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "M", lastName: `N${n}`, email, biometricId: `MN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "M", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
  await CostingPolicy.create({ companyId: co._id, ...POLICY, revision: 1, ...(legacy || {}) });
  return { co, token };
}

const LINES = [{
  lineKey: "m1", category: "MATERIAL", behaviour: "PER_UNIT", quantityPerUnit: "1",
  unitRate: { amountMinor: 10000, currency: "INR" }, confidence: "VERIFIED",
}];
const SCEN = [{ key: "q100", label: "100", quantity: "100", isPrimary: true }];

/* `rateMinor` varies the one material line, so a suite asserting the ₹500
   acceptance example does not have to restate the whole fixture. `lines` and
   `scenarios` override both outright, for the dilution test. */
const runFor = async (w, { lines, scenarios, rateMinor } = {}) => {
  const { policy } = await policyService.getPolicy({ companyId: w.co._id });
  const useLines = lines || (rateMinor === undefined ? LINES : [{
    ...LINES[0], unitRate: { amountMinor: rateMinor, currency: "INR" },
  }]);
  return calculate({ policy, lines: useLines, scenarios: scenarios || SCEN });
};

/* ═══ 1 · THE PRICE ARITHMETIC ════════════════════════════════════════════ */

describe("the floor is cost plus the approved markup", () => {
  test("₹500 at 20% is a ₹600 floor — cost × 1.20, never cost ÷ 0.80", async () => {
    /* ── THE ACCEPTANCE EXAMPLE, END TO END ───────────────────────────
       Through the real engine on a real assembled cost, not through the
       arithmetic helper alone. */
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "20" });
    const r = await runFor(w, { rateMinor: 50000 });
    const sc = r.scenarios[0];

    expect(sc.unitCostMinor).toBe(50000);
    expect(sc.floor.floorPriceMinor).toBe(60000);
    /* Asserted by name: this is what the retired formula produced from the
       same two inputs. */
    expect(sc.floor.floorPriceMinor).not.toBe(62500);
    expect(sc.floor.markupAmountMinor).toBe(10000);
    expect(sc.floor.floorMarkupPercent).toBe("20");
    expect(sc.floor.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
  });

  test("and there is no minimum, target or preferred anywhere on it", async () => {
    /* ── NO SILENT FALLBACK TO TIERS ──────────────────────────────────
       Absent, not empty. A `prices: {}` would let a reader written for the
       band find the key, read three `undefined`s and render three blank
       tiers as though the company still quoted them. */
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "20" });
    const r = await runFor(w);
    expect(r.scenarios[0].prices).toBeUndefined();
    expect(JSON.stringify(r.scenarios[0])).not.toMatch(/minimumPrice|targetPrice|preferredPrice/);
  });

  test("an approved markup of 0% prices at cost — because somebody decided that", async () => {
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "0" });
    const r = await runFor(w);
    expect(r.scenarios[0].floor.floorPriceMinor).toBe(10000);
    expect(r.scenarios[0].floor.markupAmountMinor).toBe(0);
  });

  test("each quantity gets its own floor from its own unit cost", async () => {
    /* ── FIXED-COST DILUTION MOVES THE FLOOR ──────────────────────────
       A setup charge spread over more pieces lowers the unit cost, and the
       floor follows it down. One floor per scenario, each derived from that
       scenario's own cost — never the primary's floor reused. */
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "20" });
    const r = await runFor(w, {
      scenarios: [
        { key: "q100", label: "100", quantity: "100", isPrimary: true },
        { key: "q1000", label: "1000", quantity: "1000" },
      ],
      lines: [
        ...LINES,
        {
          lineKey: "setup", category: "MISC", behaviour: "FIXED_PER_RUN",
          label: "Screen setup", amount: { amountMinor: 100000, currency: "INR" },
        },
      ],
    });
    const [small, large] = r.scenarios;
    /* ₹100.00 material + ₹1000.00 setup over 100 = ₹110.00 a piece → ₹132.00,
       which lands exactly on the ₹1 selling-price increment.
       The same setup over 1000 = ₹101.00 a piece → ₹121.20, which does NOT —
       so it is raised to ₹122.00.

       ── RAISED, NEVER LOWERED ────────────────────────────────────────
       Rounding a floor DOWN would publish a floor beneath the one management
       set, which is the one direction a floor must never move. The 80 paisa
       of uplift is recorded rather than absorbed. */
    expect(small.unitCostMinor).toBe(11000);
    expect(small.floor.floorPriceMinor).toBe(13200);
    expect(small.floor.roundingUpliftMinor).toBe(0);
    expect(large.unitCostMinor).toBe(10100);
    expect(large.floor.floorPriceMinor).toBe(12200);
    expect(large.floor.roundingUpliftMinor).toBe(80);
    /* Different floors, because different costs. */
    expect(small.floor.floorPriceMinor).not.toBe(large.floor.floorPriceMinor);
  });

  test("a floor of nil reports no percentage return rather than dividing by zero", async () => {
    /* A genuinely free garment has a floor of nil, which is a legitimate
       answer and not an occasion to compute a percentage of nothing. */
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "20" });
    const r = await runFor(w, { rateMinor: 0 });
    expect(r.scenarios[0].floor.floorPriceMinor).toBe(0);
    expect(r.scenarios[0].floor.realisedReturnOnPricePercent).toBeNull();
  });
});

/* ═══ 2 · NO POLICY IS A REFUSAL, NOT A ZERO ══════════════════════════════ */

describe("a company with no approved pricing policy", () => {
  test("fills nothing, so the engine refuses rather than pricing at cost", async () => {
    const w = await world();
    const { policy } = await policyService.getPolicy({ companyId: w.co._id });
    expect(policy.floorMarkupPercent).toBeUndefined();
    expect(() => calculate({ policy, lines: LINES, scenarios: SCEN }))
      .toThrow(/floorMarkupPercent is required/);
  });

  test("and version creation refuses by name, pointing at the Board", async () => {
    const w = await world();
    const resolved = await marginPolicy.resolveFor({ companyId: w.co._id });
    const { fail } = require("../../services/storePurchase/errors");
    let caught = null;
    try { marginPolicy.assertApproved(resolved, { fail }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("MARGIN_POLICY_REQUIRED");
    expect(caught.status).toBe(409);
    expect(caught.details.ownedBy).toBe("BOARD");
    expect(caught.details.needs).toBe("floorMarkupPercent");
    expect(caught.message).toMatch(/a markup nobody decided is not a price/);
  });

  test("a company still on the retired band is refused for a DIFFERENT reason", async () => {
    /* ── AND THIS IS THE DISTINCTION THAT MATTERS ─────────────────────
       This company HAS an approved decision. Telling it that it has none
       would be false and would send the Board looking for something it
       already did. What it lacks is a markup, and nothing converts its
       margin into one. */
    const w = await world();
    await seedHistoricalBandPolicy(w.co._id);
    const resolved = await marginPolicy.resolveFor({ companyId: w.co._id });
    expect(resolved.state).toBe("LEGACY_BAND");
    const { fail } = require("../../services/storePurchase/errors");
    let caught = null;
    try { marginPolicy.assertApproved(resolved, { fail }); } catch (e) { caught = e; }
    expect(caught.details.pricingContract).toBe("MARGIN_BAND_V1");
    expect(caught.message).toMatch(/still states the retired three-band margin/);
    /* And no markup was invented from the band it holds. */
    expect(resolved.floorMarkupPercent).toBeNull();
  });

  test("an approved 0% markup does NOT refuse — the two are different states", async () => {
    const w = await world();
    await approveMarginPolicy(w.co._id, { floorMarkupPercent: "0" });
    const resolved = await marginPolicy.resolveFor({ companyId: w.co._id });
    const { fail } = require("../../services/storePurchase/errors");
    expect(() => marginPolicy.assertApproved(resolved, { fail })).not.toThrow();
  });
});

/* ═══ 3 · EFFECTIVE DATING AND FROZEN STABILITY ═══════════════════════════ */

describe("the markup a costing is priced at is the one in force on its date", () => {
  test("a later approval does not change what an earlier date resolves", async () => {
    const w = await world();
    await approveMarginPolicy(w.co._id, {
      floorMarkupPercent: "20", effectiveFrom: new Date("2026-04-01"),
    });
    /* Management raises the markup from October. */
    await approveMarginPolicy(w.co._id, {
      floorMarkupPercent: "35", effectiveFrom: new Date("2026-10-01"),
    });

    const may = await policyService.getPolicy(
      { companyId: w.co._id }, { asOf: new Date("2026-05-01") },
    );
    expect(may.policy.floorMarkupPercent).toBe("20");
    const november = await policyService.getPolicy(
      { companyId: w.co._id }, { asOf: new Date("2026-11-01") },
    );
    expect(november.policy.floorMarkupPercent).toBe("35");

    /* And the floors differ accordingly: ₹500 costs ₹600 in May, ₹675 in
       November. A costing dated in May is priced at May's decision. */
    expect(marginPolicy.floorPriceMinorOn(50000, may.policy.floorMarkupPercent, { increment: 100 }))
      .toBe(60000);
    expect(marginPolicy.floorPriceMinorOn(50000, november.policy.floorMarkupPercent, { increment: 100 }))
      .toBe(67500);
  });

  test("a frozen provenance records the decision, not a live lookup", async () => {
    const w = await world();
    await approveMarginPolicy(w.co._id, {
      floorMarkupPercent: "20", effectiveFrom: new Date("2026-04-01"),
    });
    const resolved = await marginPolicy.resolveFor(
      { companyId: w.co._id }, { asOf: new Date("2026-05-01") },
    );
    const frozen = marginPolicy.freeze({ resolved, asOf: new Date("2026-05-01") });
    expect(frozen).toMatchObject({
      state: "APPLIED", policyKey: "MARGIN_POLICY",
      pricingContract: "MARKUP_FLOOR_V2",
      floorMarkupPercent: "20",
      calculationMethod: "MARKUP_ON_TRUE_COST",
    });
    expect(frozen.boardPolicyId).toBeTruthy();
    expect(frozen.policyApprovedByName).toBeTruthy();
    /* No band figures on it, because no band priced it. */
    expect(frozen.minimumMarginPercent).toBeNull();
    expect(frozen.approvalThresholdMarginPercent).toBeNull();
    expect(frozen.estimatedIncomeTaxRatePercent).toBeNull();

    /* A LATER decision changes nothing about that frozen object — it is a
       copy, not a reference. */
    await approveMarginPolicy(w.co._id, {
      floorMarkupPercent: "50", effectiveFrom: new Date("2026-12-01"),
    });
    const live = await marginPolicy.resolveFor(
      { companyId: w.co._id }, { asOf: new Date("2026-12-15") },
    );
    expect(live.floorMarkupPercent).toBe("50");
    /* And the frozen copy is untouched by it. */
    expect(frozen.floorMarkupPercent).toBe("20");
  });

  test("company isolation: one company's markup is not another's", async () => {
    const a = await world();
    const b = await world();
    await approveMarginPolicy(a.co._id, { floorMarkupPercent: "20" });
    const mine = await marginPolicy.resolveFor({ companyId: a.co._id });
    const theirs = await marginPolicy.resolveFor({ companyId: b.co._id });
    expect(mine.floorMarkupPercent).toBe("20");
    /* Not 20, and not zero: nothing at all. */
    expect(theirs.state).toBe("POLICY_MISSING");
    expect(theirs.floorMarkupPercent).toBeNull();
  });
});
