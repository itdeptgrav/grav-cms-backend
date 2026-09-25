// test/costing/costing-profit-bridge.test.js
//
// Central Costing — Chunk 4B. FROM AN ESTIMATED COST TO AN ESTIMATED PROFIT.
//
//     Selling price excluding GST − estimated full cost = pre-tax profit
//     − estimated income tax on positive profit = estimated after-tax profit
//
// The claims that matter are the separations. A proposed selling price must
// not move a single cost figure. GST collected from a customer is not revenue.
// Income tax is not a product cost and is not applied to a loss. And a company
// that has set no tax estimate gets "unavailable", never an after-tax profit
// equal to its pre-tax one — which would read as a tax-free business.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { seedSourceBacked, configureProduction, approveMarginPolicy, prepareForCosting } = require("./helpers/sourceBacked");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const bridge = require("../../services/centralCosting/profitBridge");

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_bridge" });
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

const newKey = () => `br-${++seq}-${Math.random().toString(36).slice(2)}`;

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


/* ═══ 1 · THE ARITHMETIC, ON ITS OWN ══════════════════════════════════════
 *
 * Pure and fast: no database, no HTTP. If these are wrong, nothing built on
 * them can be right.
 */

const scenario = (over = {}) => ({
  key: "q500", label: "500 pcs", quantity: "500",
  /* ₹200 per piece. */
  unitCostMinor: 20000, totalCostMinor: 10000000, ...over,
});
const POLICY = { minimumMarginPercent: "18", targetMarginPercent: "25", estimatedIncomeTaxRatePercent: "25" };

describe("the cost-to-profit bridge", () => {
  test("₹200 cost, ₹300 price, 25% tax → ₹100 pre-tax, ₹25 tax, ₹75 after tax", () => {
    const r = bridge.bridgeFor(scenario(), 30000, POLICY);
    expect(r.available).toBe(true);
    expect(r.preTaxProfitUnitMinor).toBe(10000);
    expect(r.estimatedIncomeTaxUnitMinor).toBe(2500);
    expect(r.afterTaxProfitUnitMinor).toBe(7500);
    /* And the same arithmetic for the whole run, not a per-unit figure
       multiplied out on screen. */
    expect(r.preTaxProfitTotalMinor).toBe(5000000);
    expect(r.estimatedIncomeTaxTotalMinor).toBe(1250000);
    expect(r.afterTaxProfitTotalMinor).toBe(3750000);
  });

  test("markup and margin are different numbers, and both are given", () => {
    /* On a ₹200 cost: a 25% MARKUP is ₹250; a 25% MARGIN is ₹266.67. People
       say one and mean the other constantly, which is why both are shown and
       neither is called "profit percent". */
    const markup25 = bridge.ratios(20000, 25000);
    expect(markup25.markupPercent).toBe("25");
    expect(markup25.marginPercent).toBe("20");

    const margin25 = bridge.ratios(20000, 26667);
    expect(Number(margin25.marginPercent)).toBeCloseTo(25, 2);
    expect(Number(margin25.markupPercent)).toBeCloseTo(33.33, 1);

    /* The engine solves for MARGIN — price = cost / (1 − m) — so 25% margin
       on ₹200 is ₹266.67 and not ₹250. */
    expect(Math.round(20000 / (1 - 0.25))).toBe(26667);
  });

  test("a loss creates no tax benefit", () => {
    const r = bridge.bridgeFor(scenario(), 15000, POLICY);
    expect(r.preTaxProfitUnitMinor).toBe(-5000);
    /* Relief for a loss depends on the company's other income and on
       carry-forward rules. A negative tax here would report a benefit nobody
       is owed and make a loss-making price look better than it is. */
    expect(r.estimatedIncomeTaxUnitMinor).toBe(0);
    expect(r.afterTaxProfitUnitMinor).toBe(-5000);
    expect(r.estimatedIncomeTaxTotalMinor).toBe(0);
  });

  test("selling at exactly cost is nil profit and nil tax, not a rounding artefact", () => {
    const r = bridge.bridgeFor(scenario(), 20000, POLICY);
    expect(r.preTaxProfitUnitMinor).toBe(0);
    expect(r.estimatedIncomeTaxUnitMinor).toBe(0);
    expect(r.afterTaxProfitUnitMinor).toBe(0);
    expect(r.markupPercent).toBe("0");
    expect(r.marginPercent).toBe("0");
  });

  test("no configured rate makes after-tax profit unavailable, never equal to pre-tax", () => {
    const r = bridge.bridgeFor(scenario(), 30000, { minimumMarginPercent: "18", targetMarginPercent: "25" });
    expect(r.preTaxProfitUnitMinor).toBe(10000);
    /* Reporting ₹100 after tax because no rate was set would say this
       company pays no income tax. */
    expect(r.incomeTaxAvailable).toBe(false);
    expect(r.estimatedIncomeTaxUnitMinor).toBeNull();
    expect(r.afterTaxProfitUnitMinor).toBeNull();
    expect(r.incomeTaxUnavailableReason).toBe("NO_INCOME_TAX_RATE");
  });

  test("no proposed price is unavailable, not a total loss", () => {
    const r = bridge.bridgeFor(scenario(), null, POLICY);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toBe("NO_PROPOSED_PRICE");
    /* A zero price would render as losing the whole ₹200 — a confident claim
       about a decision nobody has made. */
    expect(r.preTaxProfitUnitMinor).toBeUndefined();
  });

  test("a price is judged against the company's own margin band", () => {
    const band = { minimumMarginPercent: "18", targetMarginPercent: "25" };
    /* ₹210 on ₹200 is a 4.76% margin — below the floor. */
    expect(bridge.bridgeFor(scenario(), 21000, band).standing).toBe("BELOW_MINIMUM");
    /* ₹250 is 20% — above the minimum, short of the target. */
    expect(bridge.bridgeFor(scenario(), 25000, band).standing).toBe("WITHIN_POLICY");
    /* ₹300 is 33.3% — target met. */
    expect(bridge.bridgeFor(scenario(), 30000, band).standing).toBe("MEETS_TARGET");
    /* No band configured is not "any price is fine". */
    expect(bridge.bridgeFor(scenario(), 30000, {}).standing).toBe("NO_POLICY");
  });

  test("rounding stays on the money contract — integer paise throughout", () => {
    /* A rate and a quantity that do not divide evenly. */
    const r = bridge.bridgeFor(scenario({ quantity: "333" }), 30001, { estimatedIncomeTaxRatePercent: "33.33" });
    for (const k of [
      "preTaxProfitUnitMinor", "preTaxProfitTotalMinor",
      "estimatedIncomeTaxUnitMinor", "estimatedIncomeTaxTotalMinor",
      "afterTaxProfitUnitMinor", "afterTaxProfitTotalMinor",
    ]) {
      expect(Number.isInteger(r[k])).toBe(true);
    }
    /* ₹100.01 profit at 33.33% is 3333.3333 paise. Rounded by the shared
       money contract, HALF_UP, to whole paise — 3333, not carried as a
       fraction of one. */
    expect(r.estimatedIncomeTaxUnitMinor).toBe(3333);
  });

  test("a zero cost has no markup, because dividing by nothing has no answer", () => {
    const r = bridge.ratios(0, 30000);
    /* Not "infinite markup" and not 0%. */
    expect(r.markupPercent).toBeNull();
    expect(r.marginPercent).toBe("100");
  });
});


/* ═══ 2 · THE VERSION FREEZES IT, APART FROM THE COST ═════════════════════ */

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(companies = []) {
  const n = ++seq;
  const email = `bridge-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "B", lastName: `L${n}`, email, biometricId: `BR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "B" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "B", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const policyBody = (over = {}) => ({
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0, ...over,
});

async function world({ policy = {} } = {}) {
  const co = await company("Bridge");
  const me = await actor([co]);
  /* ── THE PRICING POLICY IS A MARKUP; THE TAX ESTIMATE IS NOWHERE ──────
     The band moved to the Board and was then replaced by one management
     markup. The income-tax estimate moved with the band and did NOT survive
     the replacement: it is an assumption about profit after a price is
     agreed, not an input to a floor price, and no policy accepts it any more.

     Versions frozen while it was accepted keep it and keep reporting it. New
     ones report the after-tax figures as unavailable, which is the honest
     answer and is what the tests below now assert. */
  const { estimatedIncomeTaxRatePercent, ...costingPolicy } = policy;
  const set = await call("/policy/current", {
    method: "PUT", token: me.token, company: co._id, body: policyBody(costingPolicy),
  });
  expect(set.status).toBe(200);
  /* ── A COSTING THAT COSTS EXACTLY ₹200.00 A GARMENT ──────────────────────
     This suite is about the commercial bridge — proposed price, tax, profit —
     and every figure below is read against a unit cost of 20000. The costing
     is source-backed like any other; the fixture is asked for a materials-only
     style (no operation) priced at ₹200.00 a metre with one metre a garment,
     so the assembled cost is 20000 with nothing typed by the test and no
     overhead rule in this suite's policy to add to it. */
  const seeded = await seedSourceBacked(co._id, { rateMinor: 20000 });
  /* ── NO OVERHEAD IN THIS WORLD ────────────────────────────────────────
     Every figure this suite asserts is stated to the paisa, so a 12% company
     overhead on top would be counted into all of them. Overhead's own
     participation is proved in board-overhead-costing and costing-corrections;
     what is under test here is something else. */
  await configureProduction(co._id, {
    overhead: null,
    /* ── A 50% MARKUP, SO THE COST-TO-PRICE ARITHMETIC IS READABLE ────
       On this suite's ₹200.00 unit cost that is a ₹300.00 floor — the same
       ₹300.00 the tests below propose as a price, so "at the floor" and "below
       the floor" are both one step away and stated exactly.

       `estimatedIncomeTaxRatePercent` is deliberately NOT passed: no policy
       accepts it now. A test that still needs it reads a version frozen while
       it was accepted. */
    margin: { floorMarkupPercent: "50" },
  });
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── THE RUN SIZES AND THE PROPOSED PRICES ARE THE BRIEF'S ─────────────────
 * Both used to travel on this body. A price the company proposes to sell at
 * is a commercial decision — the one figure on a costing that is not a cost —
 * and so is the quantity it is proposed for. Sales states both on the
 * enquiry, and the costing reads them.
 *
 * `calc` writes them onto the brief and posts nothing but the lines, so every
 * test below keeps its own quantities, its own prices and its own intent. */
const calc = async (w, scenarios, lines = []) => {
  const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = (scenarios || []).map((sc, i) => ({
    key: String(sc.key || `q${i + 1}`),
    label: String(sc.label || sc.key || `q${i + 1}`),
    quantity: String(sc.quantity),
    isPrimary: sc.isPrimary === true || (scenarios.length === 1 && i === 0),
    ...(sc.proposedSellingPriceExclTax
      ? {
        proposedSellingPriceExclTax: String(
          Number(sc.proposedSellingPriceExclTax.amountMinor) / 100,
        ),
      }
      : {}),
  }));
  if (!enquiry.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    enquiry.costingBriefs[0].quantities[0].isPrimary = true;
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
  /* ── PREPARED THE WAY SALES DOES ────────────────────────────────────
     `POST /:id/versions` was Calculate and refuses a browser client now. What
     this suite proves — how the bridge reads the brief's proposed price
     against the company's margin policy — is the engine's, and the engine is
     unchanged. `lines` never reached it: the server assembles its own rows. */
  if (lines.length) {
    return call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines },
    });
  }
  return prepareForCosting(w.costingId);
};

const priced = (priceMinor, over = {}) => [{
  key: "q500", label: "500 pcs", quantity: "500", isPrimary: true,
  ...(priceMinor === null ? {} : { proposedSellingPriceExclTax: { amountMinor: priceMinor, currency: "INR" } }),
  ...over,
}];

describe("what the version freezes", () => {
  test("the proposed price and the bridge are frozen, judged against the floor", async () => {
    const w = await world();
    const r = await calc(w, priced(30000));
    expect(r.status).toBe(201);

    const b = r.body.versions[0].margin.bridge;
    /* ── AND NO TAX ASSUMPTION AT ALL ──────────────────────────────────
       The income-tax estimate went with the retired band and did not survive
       into the pricing floor: it is an assumption about profit after a price
       is agreed, not an input to a floor. Reported as UNAVAILABLE rather than
       as nil, because "nobody has told us the rate" and "the tax is nothing"
       are different answers. */
    expect(b.estimatedIncomeTaxRatePercent).toBeNull();
    /* Labelled in the response, not only on the screen. */
    expect(b.basis).toBe("PRE_PRODUCTION_ESTIMATE");

    const row = b.scenarios[0];
    expect(row.unitCostMinor).toBe(20000);
    expect(row.proposedPriceExclTaxMinor).toBe(30000);
    expect(row.preTaxProfitUnitMinor).toBe(10000);
    expect(row.estimatedIncomeTaxUnitMinor).toBeNull();
    expect(row.afterTaxProfitUnitMinor).toBeNull();
    /* What the run would invoice, excluding GST — computed on the server so
       no screen multiplies money for itself. */
    expect(row.proposedRevenueTotalMinor).toBe(15000000);
    /* ── THE FLOOR, AND WHERE THIS PRICE STANDS AGAINST IT ─────────────
       ₹200.00 cost at a 50% markup is a ₹300.00 floor, and ₹300.00 proposed
       is exactly at it. At the floor is AT_OR_ABOVE: a floor is the lowest
       acceptable price, not a price to beat. */
    expect(row.floorPriceMinor).toBe(30000);
    expect(row.standing).toBe("AT_OR_ABOVE_FLOOR");
    /* Both ratios, because people confuse them. */
    expect(row.markupPercent).toBe("50");
    expect(Number(row.marginPercent)).toBeCloseTo(33.33, 1);

    /* Stored apart from the cost, so a reader can tell which figures are
       what it costs and which are what somebody hopes to sell it for. */
    const stored = await CostingVersion.findById(r.body.versions[0].id).lean();
    expect(stored.commercial.proposedPrices).toEqual([
      { scenarioKey: "q500", priceExclTaxMinor: 30000, currency: "INR" },
    ]);
    /* The rule that priced it, frozen: the markup and the formula, so the
       floor can be reproduced rather than assumed. */
    expect(stored.policySnapshot.floorMarkupPercent).toBe("50");
    expect(stored.policySnapshot.pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(stored.scenarios[0].floor.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
    /* And no band on it anywhere — absent, not blank. */
    expect(stored.policySnapshot.minimumMarginPercent).toBeUndefined();
    expect(stored.scenarios[0].prices?.minimum).toBeUndefined();
  });

  test("a proposed price cannot move a single cost figure", async () => {
    const w = await world();
    const cheap = await calc(w, priced(21000));
    const dear = await calc(w, priced(90000));
    expect(cheap.status).toBe(201);
    expect(dear.status).toBe(201);

    const costOf = (r) => {
      const s = r.body.versions[0].cost.scenarios[0];
      return { unit: s.unitCostMinor, total: s.totalCostMinor };
    };
    /* The engine never receives the price — it is stripped before the call,
       rather than passed and trusted to be ignored. */
    expect(costOf(dear)).toEqual(costOf(cheap));
    expect(costOf(cheap).unit).toBe(20000);
    /* Only the commercial answer moves. */
    expect(dear.body.versions[0].margin.bridge.scenarios[0].preTaxProfitUnitMinor).toBe(70000);
  });

  test("the price is stripped before the engine, not merely ignored by it", () => {
    /* ── A STRUCTURAL PROPERTY, PINNED AS ONE ──────────────────────────
       The engine does not read a proposed price today, so passing one in
       changes no result and no behavioural test can tell the two apart. What
       the strip buys is that it never CAN: cost answers what the product is
       estimated to cost, and the guarantee that no cost figure moves when a
       price changes is a fact only while the engine cannot see one. Passing
       it in and relying on the engine not to look would make that guarantee
       a convention instead. */
    const src = require("fs")
      .readFileSync(require("path").join(__dirname, "../../services/centralCosting/versionCreation.service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(src).toMatch(/scenarios: input\.scenarios\.map\(\(\{ proposedSellingPriceExclTax, \.\.\.s \}\) => s\)/);
    /* And the engine itself never mentions one. */
    const engine = require("fs")
      .readFileSync(require("path").join(__dirname, "../../services/centralCosting/engine.js"), "utf8");
    expect(engine).not.toMatch(/proposedSellingPrice/);
  });

  test("no rate configured freezes the bridge with the tax figures unavailable", async () => {
    const w = await world();
    const r = await calc(w, priced(30000));
    expect(r.status).toBe(201);
    const row = r.body.versions[0].margin.bridge.scenarios[0];
    expect(row.preTaxProfitUnitMinor).toBe(10000);
    /* Null, not 0. A company that has set no estimate is not a company that
       pays no income tax. */
    expect(row.estimatedIncomeTaxUnitMinor).toBeNull();
    expect(row.afterTaxProfitUnitMinor).toBeNull();
    expect(r.body.versions[0].margin.bridge.estimatedIncomeTaxRatePercent).toBeNull();
  });

  test("a costing with no proposed price has no commercial block at all", async () => {
    const w = await world();
    const r = await calc(w, priced(null));
    expect(r.status).toBe(201);
    /* Absent, not an empty block that reads as a considered blank. */
    expect(r.body.versions[0].margin.bridge).toBeNull();
    const stored = await CostingVersion.findById(r.body.versions[0].id).lean();
    expect(stored.commercial).toBeUndefined();
  });

  test("only priced scenarios appear on the bridge", async () => {
    const w = await world();
    const r = await calc(w, [
      ...priced(30000),
      { key: "q2000", label: "2000 pcs", quantity: "2000" },
    ]);
    expect(r.status).toBe(201);
    /* Both quantities are costed; only one has a price proposed for it, and
       its absence is the answer for the other. */
    expect(r.body.versions[0].cost.scenarios).toHaveLength(2);
    expect(r.body.versions[0].margin.bridge.scenarios.map((s) => s.scenarioKey)).toEqual(["q500"]);
  });

  test("a later markup change does not restate a frozen floor or standing", async () => {
    const w = await world();
    const r = await calc(w, priced(30000));
    const versionId = r.body.versions[0].id;
    const before = r.body.versions[0].margin.bridge.scenarios[0];
    expect(before.floorPriceMinor).toBe(30000);
    expect(before.standing).toBe("AT_OR_ABOVE_FLOOR");

    /* ── MANAGEMENT RAISES THE MARKUP ────────────────────────────────
       An approval with an effective date, not a policy save. At 100% the
       floor on this cost would be ₹400.00 and the same ₹300.00 price would
       be BELOW it — so if the frozen version were re-read against the new
       policy, its standing would flip. */
    await approveMarginPolicy(w.co._id, {
      floorMarkupPercent: "100",
      effectiveFrom: new Date(Date.now() - 1 * 24 * 3600 * 1000),
    });

    const again = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = again.body.versions.find((x) => x.id === versionId);
    /* A snapshot, not a reference. Otherwise every historical costing
       silently restates where its price stood the day management moves the
       markup — and a price that was compliant becomes one that needed an
       approval nobody ever asked for. */
    expect(v.margin.bridge.scenarios[0].floorPriceMinor).toBe(30000);
    expect(v.margin.bridge.scenarios[0].standing).toBe("AT_OR_ABOVE_FLOOR");
  });

  test("the tax rate is not a pricing input anywhere, and is refused by name", async () => {
    /* ── IT LEFT WITH THE BAND, AND DID NOT COME BACK ─────────────────
       An estimated income-tax rate is an assumption about profit AFTER a
       price is agreed. It never entered the cost build-up and it is not part
       of a floor price, so no policy accepts it — refused rather than ignored,
       because a body answered 200 while nothing it sent was stored would let
       somebody believe the company's assumption had changed.

       Where it lives instead is a separate management-reporting question that
       is deliberately not built here. */
    const boardPolicy = require("../../services/board/boardPolicy.service");
    expect(() => boardPolicy.CONTRACT.MARGIN_POLICY.validate(
      { estimatedIncomeTaxRatePercent: "30" }, {},
    )).toThrow(/not part of a product's cost/);
    /* And so are the four retired band inputs. */
    for (const retired of [
      "minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent",
      "approvalThresholdMarginPercent",
    ]) {
      expect([retired, (() => {
        try {
          boardPolicy.CONTRACT.MARGIN_POLICY.validate({ [retired]: "20" }, {});
          return "accepted";
        } catch (e) { return e.details?.reason || "threw"; }
      })()]).toEqual([retired, "MARGIN_BAND_RETIRED"]);
    }

    /* ── AND THE COSTING POLICY REFUSES IT, BUT STILL CLEARS ──────────
       Showing nothing is better than an assumption the company no longer
       stands behind, so retiring a carried value is allowed; authoring one is
       not. */
    const w = await world();
    const authored = await call("/policy/current", {
      method: "PUT", token: w.me.token, company: w.co._id,
      body: policyBody({ estimatedIncomeTaxRatePercent: "30", revision: 1 }),
    });
    expect(authored.status).toBe(409);
    expect(authored.body.error.code).toBe("MARGIN_POLICY_MOVED");

    const cleared = await call("/policy/current", {
      method: "PUT", token: w.me.token, company: w.co._id,
      body: policyBody({ estimatedIncomeTaxRatePercent: null, revision: 1 }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.policy.estimatedIncomeTaxRatePercent).toBeNull();
  });

  test("a price below the floor is frozen and flagged, not refused", async () => {
    const w = await world();
    const r = await calc(w, priced(21000));
    /* Recording a bad price is how somebody argues about it. Refusing it
       would send the argument off the system. */
    expect(r.status).toBe(201);
    const row = r.body.versions[0].margin.bridge.scenarios[0];
    /* ₹210.00 against a ₹300.00 floor. The standing is published; acting on
       it — the management approval it calls for — is a workflow this task
       deliberately does not build. */
    expect(row.floorPriceMinor).toBe(30000);
    expect(row.standing).toBe("BELOW_FLOOR");
    expect(row.preTaxProfitUnitMinor).toBe(1000);
  });

  test("and one at a penny above the floor is not", async () => {
    /* The boundary, stated: the difference between needing an approval and
       not needing one is one paisa, and it must fall on the right side. */
    const w = await world();
    const r = await calc(w, priced(30001));
    expect(r.body.versions[0].margin.bridge.scenarios[0].standing).toBe("AT_OR_ABOVE_FLOOR");
    const under = await calc(w, priced(29999));
    expect(under.body.versions[0].margin.bridge.scenarios[0].standing).toBe("BELOW_FLOOR");
  });
});
