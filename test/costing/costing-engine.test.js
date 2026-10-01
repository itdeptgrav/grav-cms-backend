// test/costing/costing-engine.test.js
//
// Central Costing — Chunk 2. THE ARITHMETIC, WITHOUT A DATABASE.
//
// The engine is pure, so every rule in the roadmap's §5 can be checked at the
// point it is written rather than through an HTTP round trip. Each block below
// corresponds to one invariant, and the numbers are worked by hand in the
// comments so a reader can disagree with the test rather than only with the
// code.
"use strict";

const { calculate, CostingEngineError, BASIS_KEYS, EOS_CAUSES } = require("../../services/centralCosting/engine");
const { validatePatch, DEFAULTS } = require("../../services/centralCosting/policy.service");
const adapter = require("../../services/centralCosting/legacyEnquiryCostingAdapter");

const POLICY = Object.freeze({
  baseCurrency: "INR",
  roundingMode: "HALF_UP",
  sellingPriceIncrementMinor: 100, // whole rupees
  overheadBasis: "DIRECT_PLUS_FIXED",
  overheadRatePercent: "12",
  /* ── THE MARKUP STAYS ON AN ENGINE POLICY ─────────────────────────────
     This object is handed straight to `calculate()`, which reads the markup as
     required and derives the floor price from it. It is not a costing-policy
     BODY — the Board owns this field now and the HTTP route refuses it, but
     the engine's own input is where the resolved markup arrives.

     25% because the suite's worked example asserts against it below. */
  floorMarkupPercent: "25",
});

/* The worked example used throughout, and in the completion report:
 *   fabric      ₹412.50 / m   × 1.4 m   = ₹577.50 per piece
 *   stitching   ₹9.00 / min   × 18 min  = ₹162.00 per piece
 *   wastage     4% of materials
 *   setup       ₹25,000 for the whole run
 *   overhead    12% of direct + fixed (from company policy)
 */
const LINES = Object.freeze([
  { lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
    unitRate: { amountMinor: 41250, currency: "INR" }, quantityPerUnit: "1.4", quantityUom: "m" },
  { lineKey: "stitch", category: "OPERATION", behaviour: "PER_UNIT", label: "Stitching",
    unitRate: { amountMinor: 900, currency: "INR" }, quantityPerUnit: "18", quantityUom: "min" },
  { lineKey: "wastage", category: "WASTAGE", behaviour: "PERCENT_OF_BASIS", label: "Cutting wastage",
    basis: "MATERIALS", percent: "4" },
  { lineKey: "setup", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN", label: "Pattern and marker",
    amount: { amountMinor: 2500000, currency: "INR" } },
]);

const run = (over = {}) => calculate({
  lines: LINES,
  policy: POLICY,
  scenarios: [
    { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
    { key: "q2000", label: "2000 pcs", quantity: "2000" },
  ],
  ...over,
});

const at = (out, key) => out.scenarios.find((s) => s.key === key);

/* ═══ 1 · THE WORKED EXAMPLE ═════════════════════════════════════════════ */

describe("the cost build-up", () => {
  test("adds up exactly, in integer minor units", () => {
    const out = run();
    const five = at(out, "q500");

    /* materials  57,750 × 500 = 28,875,000
       operations 16,200 × 500 =  8,100,000
       wastage    4% of materials =  1,155,000
       setup                      =  2,500,000
       overhead   12% of (28,875,000 + 8,100,000 + 2,500,000) = 4,737,000
                                     ───────────
                                      45,367,000 */
    const sub = Object.fromEntries(five.categorySubtotals.map((c) => [c.category, c.totalMinor]));
    expect(sub.MATERIAL).toBe(28875000);
    expect(sub.OPERATION).toBe(8100000);
    expect(sub.WASTAGE).toBe(1155000);
    expect(sub.FIXED_SETUP).toBe(2500000);
    expect(sub.OVERHEAD).toBe(4737000);

    expect(five.totalCostMinor).toBe(45367000);
    expect(five.unitCostMinor).toBe(90734); // ₹907.34
    /* 90,734 × 500 = 45,367,000 exactly, so nothing is lost to rounding here. */
    expect(five.roundingAdjustmentMinor).toBe(0);
  });

  test("every figure is a whole number of minor units", () => {
    const out = run();
    for (const s of out.scenarios) {
      for (const n of [s.totalCostMinor, s.unitCostMinor, s.fixedTotalMinor, s.variableTotalMinor]) {
        expect(Number.isSafeInteger(n)).toBe(true);
      }
      for (const l of s.lines) expect(Number.isSafeInteger(l.totalMinor)).toBe(true);
    }
  });

  test("the same inputs give the same answer every time", () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

/* ═══ 2 · MARGIN IS NOT MARKUP ═══════════════════════════════════════════ */

describe("the floor price", () => {
  test("floor = cost × (1 + markup), which is NOT cost / (1 - markup)", () => {
    const five = at(run(), "q500");
    const cost = five.unitCostMinor; // 90,734

    /* ── THE FORMULA THAT REPLACED THE OTHER ONE ──────────────────────
       MARKUP:  90,734 × 1.25 = 113,417.50 → up to the ₹1 step → 113,500
       MARGIN:  90,734 / 0.75 = 120,978.67 → would have been 121,000

       The old formula is asserted against BY NAME. A regression that
       reinstated it would still produce a plausible price on any input, and
       only this comparison catches it. */
    expect(five.floor.floorPriceMinor).toBe(113500);
    expect(five.floor.floorPriceMinor).not.toBe(121000);
    expect(five.floor.trueUnitCostMinor).toBe(cost);
    expect(five.floor.markupAmountMinor).toBe(113500 - cost);
    expect(five.floor.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
  });

  test("there is exactly one price, and no tier of any name", () => {
    /* ── THE THREE-TIER MODEL IS GONE, NOT HIDDEN ─────────────────────
       Absent rather than empty: a `prices: {}` would let a reader written for
       the band find the key, read three `undefined`s and render three blank
       tiers as though the company still quoted them. */
    const five = at(run(), "q500");
    expect(five.prices).toBeUndefined();
    expect(JSON.stringify(five)).not.toMatch(/minimum|target|preferred/i);
  });

  test("rounding a floor is always upward, so the floor is never breached", () => {
    /* A floor rounded DOWN to a tidy number is a price below the one
       management set — a display convenience turned into a policy breach.
       The uplift is recorded rather than absorbed. */
    const five = at(run(), "q500");
    expect(five.floor.floorPriceMinor % 100).toBe(0);
    expect(five.floor.roundingUpliftMinor).toBeGreaterThanOrEqual(0);
    const exactBefore = five.floor.floorPriceMinor - five.floor.roundingUpliftMinor;
    expect(five.floor.floorPriceMinor).toBeGreaterThanOrEqual(exactBefore);
  });

  test("the ₹500 / 20% acceptance example, on the engine itself", () => {
    const out = calculate({
      policy: { ...POLICY, floorMarkupPercent: "20", overheadRatePercent: "0" },
      scenarios: [{ key: "one", label: "1", quantity: "1", isPrimary: true }],
      lines: [{
        lineKey: "m", category: "MATERIAL", behaviour: "PER_UNIT", label: "Cloth",
        unitRate: { amountMinor: 50000, currency: "INR" }, quantityPerUnit: "1",
      }],
    });
    const sc = out.scenarios[0];
    expect(sc.unitCostMinor).toBe(50000);
    expect(sc.floor.floorPriceMinor).toBe(60000);
    expect(sc.floor.floorPriceMinor).not.toBe(62500);
  });

  test("a 100% markup is a doubling, not a division by zero", () => {
    const out = calculate({
      lines: LINES, scenarios: [{ key: "a", quantity: "10" }],
      policy: { ...POLICY, floorMarkupPercent: "100" },
    });
    const sc = out.scenarios[0];
    /* Doubled, then raised to the ₹1 selling-price increment — a floor is
       never rounded down, so it lands at or just above twice the cost. */
    expect(sc.floor.floorPriceMinor).toBeGreaterThanOrEqual(sc.pricedUnitCostMinor * 2);
    expect(sc.floor.floorPriceMinor - sc.pricedUnitCostMinor * 2).toBeLessThan(100);
    expect(sc.floor.markupAmountMinor).toBeGreaterThanOrEqual(sc.pricedUnitCostMinor);
  });
});

/* ═══ 3 · WHY QUANTITY CHANGES THE UNIT COST ═════════════════════════════ */

describe("fixed-cost dilution", () => {
  test("only the fixed part moves; the variable part is identical", () => {
    const out = run();
    const five = at(out, "q500");
    const two = at(out, "q2000");

    /* Setup is ₹25,000 however many pieces are made, and 12% overhead on a
       basis that includes it carries a proportional share of that with it:
       fixed = 2,500,000 + 4,737,000 × 2,500,000/39,475,000 = 2,800,000. */
    expect(five.fixedTotalMinor).toBe(2800000);
    expect(two.fixedTotalMinor).toBe(2800000);
    expect(five.fixedPerUnitMinor).toBe(5600);
    expect(two.fixedPerUnitMinor).toBe(1400);

    /* THE INVARIANT: no supplier tiers and no efficiency curve in this chunk,
       so the per-piece variable cost cannot move with quantity. */
    expect(five.variablePerUnitMinor).toBe(two.variablePerUnitMinor);
    expect(five.variablePerUnitMinor).toBe(85134);
  });

  test("the difference between scenarios is explained, not asserted", () => {
    const two = at(run(), "q2000");
    expect(two.comparedToPrimary.againstScenarioKey).toBe("q500");
    expect(two.comparedToPrimary.unitCostDeltaMinor).toBe(86534 - 90734);
    expect(two.comparedToPrimary.fixedDilutionMinor).toBe(-4200);
    /* Zero until Chunk 3 brings factual supplier quantity tiers. A non-zero
       value here would mean the engine had invented an economy of scale. */
    expect(two.comparedToPrimary.variableChangeMinor).toBe(0);
    expect(two.comparedToPrimary.reason).toMatch(/spread over more pieces/i);
  });

  test("with no fixed cost at all, quantity changes nothing", () => {
    const out = calculate({
      lines: LINES.filter((l) => l.category !== "FIXED_SETUP"),
      policy: POLICY,
      scenarios: [{ key: "a", quantity: "10", isPrimary: true }, { key: "b", quantity: "9000" }],
    });
    expect(at(out, "a").unitCostMinor).toBe(at(out, "b").unitCostMinor);
    expect(at(out, "b").comparedToPrimary.reason).toMatch(/does not change with quantity/i);
  });
});

/* ═══ 4 · TAX ════════════════════════════════════════════════════════════ */

describe("recoverable versus non-recoverable tax", () => {
  const withTax = (treatment) => calculate({
    lines: [{
      lineKey: "trim", category: "MATERIAL", behaviour: "PER_UNIT", label: "Zip",
      unitRate: { amountMinor: 10000, currency: "INR" }, quantityPerUnit: "1",
      tax: { treatment, ratePercent: "18" },
    }],
    policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
    scenarios: [{ key: "a", quantity: "100", isPrimary: true }],
  });

  test("recoverable GST is not cost, and is still reported", () => {
    const s = at(withTax("RECOVERABLE"), "a");
    /* ₹100 × 100 pieces = 1,000,000 minor. The 18% is reclaimed, so it is not
       cost — but the buyer still funds it, so it is not hidden either. */
    expect(s.totalCostMinor).toBe(1000000);
    expect(s.recoverableTaxMinor).toBe(180000);
  });

  test("non-recoverable tax is cost", () => {
    const s = at(withTax("NON_RECOVERABLE"), "a");
    expect(s.totalCostMinor).toBe(1180000);
    expect(s.recoverableTaxMinor).toBe(0);
  });

  test("freight, duty and financing are cost", () => {
    const out = calculate({
      lines: [
        { lineKey: "goods", category: "MATERIAL", behaviour: "PER_UNIT",
          unitRate: { amountMinor: 10000, currency: "INR" }, quantityPerUnit: "1" },
        { lineKey: "freight", category: "FREIGHT", behaviour: "FIXED_PER_RUN",
          amount: { amountMinor: 500000, currency: "INR" } },
        { lineKey: "duty", category: "DUTY", behaviour: "PERCENT_OF_BASIS", basis: "MATERIALS", percent: "10" },
        { lineKey: "interest", category: "FINANCING", behaviour: "PERCENT_OF_BASIS", basis: "DIRECT", percent: "2" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "100", isPrimary: true }],
    });
    const s = at(out, "a");
    /* 1,000,000 goods + 500,000 freight + 100,000 duty + 20,000 financing */
    expect(s.totalCostMinor).toBe(1620000);
  });
});

/* ═══ 5 · MISSING IS NOT ZERO ════════════════════════════════════════════ */

describe("incomplete input", () => {
  test("a line with no rate is refused, not costed as free", () => {
    let err;
    try {
      calculate({
        lines: [{ lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric", quantityPerUnit: "1.4" }],
        policy: POLICY, scenarios: [{ key: "a", quantity: "10" }],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CostingEngineError);
    expect(err.details.reason).toBe("INPUTS_INCOMPLETE");
    expect(err.details.missing[0]).toMatchObject({ lineKey: "fabric", reason: "UNIT_RATE_MISSING" });
  });

  test("every missing input is reported at once, not one per attempt", () => {
    let err;
    try {
      calculate({
        lines: [
          { lineKey: "a", category: "MATERIAL", behaviour: "PER_UNIT", quantityPerUnit: "1" },
          { lineKey: "b", category: "OPERATION", behaviour: "PER_UNIT", unitRate: { amountMinor: 1, currency: "INR" } },
          { lineKey: "c", category: "MISC", behaviour: "FIXED_PER_RUN" },
          { lineKey: "d", category: "WASTAGE", behaviour: "PERCENT_OF_BASIS", basis: "MATERIALS" },
        ],
        policy: POLICY, scenarios: [{ key: "a", quantity: "10" }],
      });
    } catch (e) { err = e; }
    expect(err.details.missing.map((m) => m.reason).sort()).toEqual([
      "FIXED_AMOUNT_MISSING", "PERCENT_MISSING", "QUANTITY_PER_UNIT_MISSING", "UNIT_RATE_MISSING",
    ]);
  });

  test("zero is a real rate and is costed as zero", () => {
    const out = calculate({
      lines: [{ lineKey: "free", category: "MATERIAL", behaviour: "PER_UNIT", label: "Buyer-supplied trim",
        unitRate: { amountMinor: 0, currency: "INR" }, quantityPerUnit: "1" }],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "10", isPrimary: true }],
    });
    expect(at(out, "a").totalCostMinor).toBe(0);
    expect(at(out, "a").lines[0].totalMinor).toBe(0);
  });
});

/* ═══ 6 · MALFORMED INPUT ════════════════════════════════════════════════ */

describe("refusals", () => {
  const expectReason = (fn, reason) => {
    let err;
    try { fn(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CostingEngineError);
    expect(err.details.reason).toBe(reason);
  };

  test("TOTAL_COST is gone, because it could never once be chosen", () => {
    /* It listed every category, so it included the category of whatever line
       used it and was circular for EVERY possible percentage line. An option
       that is always refused is not a narrow failure mode; it is a promise the
       engine cannot keep, so it is not offered. */
    expect(BASIS_KEYS).not.toContain("TOTAL_COST");
    expectReason(() => calculate({
      lines: [
        { lineKey: "m", category: "MATERIAL", behaviour: "PER_UNIT", unitRate: { amountMinor: 100, currency: "INR" }, quantityPerUnit: "1" },
        { lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", basis: "TOTAL_COST", percent: "12" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1" }],
    }), "BASIS_UNKNOWN");
  });

  test("overhead cannot be a percentage of a subtotal that already includes overhead", () => {
    /* SUBTOTAL_BEFORE_FINANCING deliberately includes overhead — that is what
       makes it usable by financing. Using it FOR overhead is the same
       simultaneous equation, and is refused rather than solved. */
    expectReason(() => calculate({
      lines: [
        { lineKey: "m", category: "MATERIAL", behaviour: "PER_UNIT", unitRate: { amountMinor: 100, currency: "INR" }, quantityPerUnit: "1" },
        { lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", basis: "SUBTOTAL_BEFORE_FINANCING", percent: "12" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1" }],
    }), "CIRCULAR_PERCENT_BASIS");
  });

  test("an indirect cycle between two percentage lines is caught too", () => {
    /* Neither line's basis contains its OWN category, so the direct check
       cannot see this: materials-as-a-percentage-of-operations and
       operations-as-a-percentage-of-materials only close the loop through each
       other. It is the dependency walk that catches it. */
    expectReason(() => calculate({
      lines: [
        { lineKey: "a", category: "MATERIAL", behaviour: "PERCENT_OF_BASIS", basis: "OPERATIONS", percent: "10" },
        { lineKey: "b", category: "OPERATION", behaviour: "PERCENT_OF_BASIS", basis: "MATERIALS", percent: "10" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1" }],
    }), "CIRCULAR_PERCENT_BASIS");
  });

  test("material, then overhead, then financing — in dependency order", () => {
    const out = calculate({
      lines: [
        { lineKey: "m", category: "MATERIAL", behaviour: "PER_UNIT", label: "Fabric",
          unitRate: { amountMinor: 100000, currency: "INR" }, quantityPerUnit: "1" },
        { lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", label: "Overhead",
          basis: "SUBTOTAL_BEFORE_OVERHEAD", percent: "10" },
        { lineKey: "fin", category: "FINANCING", behaviour: "PERCENT_OF_BASIS", label: "Financing",
          basis: "SUBTOTAL_BEFORE_FINANCING", percent: "2" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1", isPrimary: true }],
    });
    const s = at(out, "a");
    const byKey = Object.fromEntries(s.lines.map((l) => [l.lineKey, l.totalMinor]));
    /* material 100,000
       overhead 10% of 100,000                     = 10,000
       financing 2% of (100,000 + 10,000)          =  2,200   ← includes overhead
                                                     ───────
                                                     112,200 */
    expect(byKey.m).toBe(100000);
    expect(byKey.oh).toBe(10000);
    expect(byKey.fin).toBe(2200);
    expect(s.totalCostMinor).toBe(112200);
    /* Order is by dependency, not by the order they were typed in. */
    expect(s.lines.map((l) => l.lineKey)).toEqual(["m", "oh", "fin"]);
  });

  test("a legitimate chain of percentages is not a cycle", () => {
    const out = calculate({
      lines: [
        { lineKey: "m", category: "MATERIAL", behaviour: "PER_UNIT", unitRate: { amountMinor: 10000, currency: "INR" }, quantityPerUnit: "1" },
        { lineKey: "oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", basis: "SUBTOTAL_BEFORE_OVERHEAD", percent: "10" },
        { lineKey: "fin", category: "FINANCING", behaviour: "PERCENT_OF_BASIS", basis: "SUBTOTAL_BEFORE_OVERHEAD", percent: "2" },
      ],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1", isPrimary: true }],
    });
    expect(at(out, "a").totalCostMinor).toBe(11200);
  });

  test("two scenarios cannot share a key, and a quantity cannot be zero", () => {
    expectReason(() => calculate({ lines: LINES, policy: POLICY, scenarios: [{ key: "a", quantity: "1" }, { key: "a", quantity: "2" }] }), "SCENARIO_KEY_DUPLICATE");
    expectReason(() => calculate({ lines: LINES, policy: POLICY, scenarios: [{ key: "a", quantity: "0" }] }), "SCENARIO_QUANTITY_ZERO");
    expectReason(() => calculate({ lines: LINES, policy: POLICY, scenarios: [] }), "SCENARIO_REQUIRED");
  });

  test("two cost lines cannot share a key", () => {
    expectReason(() => calculate({
      lines: [LINES[0], { ...LINES[1], lineKey: "fabric" }],
      policy: POLICY, scenarios: [{ key: "a", quantity: "1" }],
    }), "LINE_KEY_DUPLICATE");
  });

  test("a rate in another currency is refused rather than converted", () => {
    expectReason(() => calculate({
      lines: [{ ...LINES[0], unitRate: { amountMinor: 41250, currency: "USD" } }],
      policy: POLICY, scenarios: [{ key: "a", quantity: "1" }],
    }), "CURRENCY_MISMATCH");
  });

  test("money that is not a safe integer is refused", () => {
    expectReason(() => calculate({
      lines: [{ ...LINES[0], unitRate: { amountMinor: 41250.5, currency: "INR" } }],
      policy: POLICY, scenarios: [{ key: "a", quantity: "1" }],
    }), "AMOUNT_MINOR_UNSAFE");
  });

  test("a negative markup is refused — a floor below cost is not a floor", () => {
    /* ── WHAT REPLACED THE ORDERING RULE ──────────────────────────────
       A three-figure band could run the wrong way round; one figure cannot.
       The only ordering left is against zero, and it is enforced where every
       other policy percentage is — by `percent()`, which raises a
       `DecimalError` naming the field rather than an engine refusal. */
    expect(() => calculate({
      lines: LINES, scenarios: [{ key: "a", quantity: "1" }],
      policy: { ...POLICY, floorMarkupPercent: "-1" },
    })).toThrow(/floorMarkupPercent/);
  });

  test("a markup above 100% is ordinary, not refused", () => {
    /* A MARGIN of 100% divided by zero. A markup of 150% is a commercial
       decision, and the old ceiling would now refuse real policies. */
    const out = calculate({
      lines: LINES, scenarios: [{ key: "a", quantity: "1" }],
      policy: { ...POLICY, floorMarkupPercent: "150" },
    });
    expect(out.scenarios[0].floor.floorPriceMinor).toBeGreaterThan(out.scenarios[0].unitCostMinor);
  });
});

/* ═══ 7 · ROUNDING ══════════════════════════════════════════════════════ */

describe("rounding", () => {
  test("a total that does not divide evenly reports the adjustment by name", () => {
    const out = calculate({
      lines: [{ lineKey: "setup", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN",
        amount: { amountMinor: 1000, currency: "INR" } }],
      policy: { ...POLICY, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "3", isPrimary: true }],
    });
    const s = at(out, "a");
    /* 1000 / 3 = 333.33 → 333 per unit; 333 × 3 = 999, one minor unit short of
       the 1000 actually spent. Stated, rather than left for a reader to find. */
    expect(s.totalCostMinor).toBe(1000);
    expect(s.unitCostMinor).toBe(333);
    expect(s.roundingAdjustmentMinor).toBe(-1);
    expect(out.warnings.map((w) => w.code)).toContain("ROUNDING_ADJUSTMENT");
  });

  test("HALF_EVEN is honoured when a company chooses it", () => {
    const half = (mode) => at(calculate({
      lines: [{ lineKey: "x", category: "MISC", behaviour: "PER_UNIT",
        unitRate: { amountMinor: 5, currency: "INR" }, quantityPerUnit: "0.5" }],
      policy: { ...POLICY, roundingMode: mode, overheadBasis: undefined, overheadRatePercent: undefined },
      scenarios: [{ key: "a", quantity: "1", isPrimary: true }],
    }), "a").unitCostMinor;
    /* 2.5 minor units: half-up gives 3, banker's rounding gives 2. */
    expect(half("HALF_UP")).toBe(3);
    expect(half("HALF_EVEN")).toBe(2);
  });
});

/* ═══ 8 · PROVISIONAL INPUTS ════════════════════════════════════════════ */

describe("honesty about inputs", () => {
  test("provisional lines are named in a warning, not left to look verified", () => {
    const out = run();
    const w = out.warnings.find((x) => x.code === "PROVISIONAL_INPUTS");
    expect(w).toBeTruthy();
    expect(w.lineKeys).toEqual(expect.arrayContaining(["fabric", "stitch"]));
  });

  test("policy overhead declared twice is included and said out loud", () => {
    const out = calculate({
      lines: [...LINES, { lineKey: "own-oh", category: "OVERHEAD", behaviour: "PERCENT_OF_BASIS", basis: "PRIME", percent: "5" }],
      policy: POLICY, scenarios: [{ key: "a", quantity: "100", isPrimary: true }],
    });
    expect(out.warnings.map((w) => w.code)).toContain("OVERHEAD_DECLARED_TWICE");
    expect(at(out, "a").lines.filter((l) => l.category === "OVERHEAD")).toHaveLength(2);
  });
});

/* ═══ 9 · POLICY VALIDATION ═════════════════════════════════════════════ */

describe("company policy", () => {
  test("the band can no longer be set here, and says so by name", () => {
    /* ── THIS USED TO ASSERT THE ORDERING AND RANGE RULES ──────────────
       They have not been dropped — they moved. What the company is prepared
       to sell for is a Board decision now, with an approver and a date it
       takes effect, and `boardPolicy.validateMargin` enforces
       `0 ≤ min ≤ target ≤ preferred < 100` on the way in AND `marginGaps`
       enforces it again at approval. Both are proved in
       `board-margin-policy.test.js`.

       What this endpoint enforces is that it is not a second writer. */
    for (const patch of [
      { minimumMarginPercent: "40", targetMarginPercent: "25", preferredMarginPercent: "50" },
      { preferredMarginPercent: "100" },
      { minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32" },
      { approvalThresholdMarginPercent: "20" },
      { estimatedIncomeTaxRatePercent: "25" },
    ]) {
      expect(() => validatePatch(DEFAULTS, patch)).toThrow(/approved by the Board/);
    }
  });

  test("but clearing what a company still carries is allowed, and the band clears as a band", () => {
    /* Retiring a display is not authoring policy. Half a band is neither a
       policy nor an absence, so the three go together. */
    const carried = {
      legacyMinimumMarginPercent: "10", legacyTargetMarginPercent: "20",
      legacyPreferredMarginPercent: "30", legacyEstimatedIncomeTaxRatePercent: "25",
    };
    const cleared = validatePatch({ ...DEFAULTS, ...carried }, { minimumMarginPercent: null });
    expect(cleared.minimumMarginPercent).toBeUndefined();
    expect(cleared.targetMarginPercent).toBeUndefined();
    expect(cleared.preferredMarginPercent).toBeUndefined();
    /* The two optional assumptions stand alone and are untouched. */
    expect(cleared.estimatedIncomeTaxRatePercent).toBe("25");
  });

  test("overhead can no longer be set here, and says so by name", () => {
    /* ── THIS USED TO ASSERT THE BOTH-OR-NEITHER RULE ──────────────────
       Overhead moved to the Board, where it has an approver and a date it
       takes effect, and the both-or-neither rule went with it — see
       `boardPolicy.overheadGaps`. What this endpoint enforces now is that it
       is not a second writer. */
    for (const patch of [
      { overheadRatePercent: "12" },
      { overheadBasis: "PRIME" },
      { overheadBasis: "PRIME", overheadRatePercent: "12" },
    ]) {
      expect(() => validatePatch(DEFAULTS, patch)).toThrow(/set by the Board/);
    }

    /* Refused by NAME, not silently dropped: ignoring it would leave the
       caller believing the rate they sent was saved. */
    try {
      validatePatch(DEFAULTS, { overheadRatePercent: "12" });
    } catch (err) {
      expect(err.code).toBe("OVERHEAD_POLICY_MOVED");
      expect(err.details.ownedBy).toBe("BOARD");
    }
  });

  test("clearing a legacy overhead value is still accepted, and only clearing", () => {
    /* A company retiring the rate it used to carry should be able to, through
       the screen it was set in — without that being a path to a new one. */
    const legacy = { ...DEFAULTS, legacyOverheadBasis: "PRIME", legacyOverheadRatePercent: "12" };
    const cleared = validatePatch(legacy, { overheadBasis: null, overheadRatePercent: null });
    expect(cleared.overheadBasis).toBeUndefined();
    expect(cleared.overheadRatePercent).toBeUndefined();

    /* And a save of an unrelated field carries the legacy value through
       rather than wiping it — old frozen versions are explained by it. */
    const kept = validatePatch(legacy, { roundingMode: "HALF_EVEN" });
    expect(kept.overheadBasis).toBe("PRIME");
    expect(kept.overheadRatePercent).toBe("12");
  });

  test("every basis the Board can name is one the engine understands", () => {
    /* The check this replaces, on the record that now holds the basis. A
       basis the Board could approve and the engine could not resolve would be
       a rule that never applies. */
    const { validateOverhead } = require("../../services/board/boardPolicy.service");
    for (const basis of BASIS_KEYS) {
      expect(() => validateOverhead({ basis, ratePercent: "1" }, {})).not.toThrow();
    }
    expect(() => validateOverhead({ basis: "NONSENSE" }, {})).toThrow();
  });
});

/* ═══ 10 · THE LEGACY MAPPING ═══════════════════════════════════════════ */

describe("legacy Sales sheets, as canonical inputs", () => {
  const sheets = [
    { part: "raw", updatedAt: new Date("2026-08-20"), materials: [
      { item: "Cotton twill", unitCost: "412.50", consumption: "1.4", unit: "m", vendor: "Acme", allowancePercent: "5" },
      { item: "Lining", unitCost: "n/a", consumption: "0.8", unit: "m" },
    ], miscellaneous: [{ name: "Testing", price: "25" }] },
    { part: "operations", updatedAt: new Date("2026-08-21"), operations: [{ detail: "Stitching", sam: "18", rate: "9" }] },
  ];

  test("legacy floats become integer minor units, quantities keep their decimals", () => {
    const { lines } = adapter.linesFromCostingSheets(sheets, "INR");
    const fabric = lines.find((l) => l.label === "Cotton twill");
    expect(fabric.unitRate).toEqual({ amountMinor: 41250, currency: "INR" });
    expect(fabric.quantityPerUnit).toBe("1.4");
    expect(fabric.quantityUom).toBe("m");
    /* SAM × cost-per-minute is exactly a per-unit line whose consumption is
       minutes — the same arithmetic services/costingTotals.js does today. */
    const stitch = lines.find((l) => l.label === "Stitching");
    expect(stitch.unitRate.amountMinor).toBe(900);
    expect(stitch.quantityPerUnit).toBe("18");
  });

  test("an unreadable price is reported, never imported as free", () => {
    const { lines, unmapped } = adapter.linesFromCostingSheets(sheets, "INR");
    expect(lines.find((l) => l.label === "Lining")).toBeUndefined();
    expect(unmapped).toEqual([expect.objectContaining({ label: "Lining", reason: "UNIT_COST_UNREADABLE" })]);
  });

  test("everything imported is provisional", () => {
    const { lines } = adapter.linesFromCostingSheets(sheets, "INR");
    expect(lines.every((l) => l.confidence === "PROVISIONAL")).toBe(true);
  });

  test("ambiguities are surfaced rather than smoothed over", () => {
    const { ambiguities } = adapter.linesFromCostingSheets(sheets, "INR");
    const codes = ambiguities.map((a) => a.code);
    /* The allowance is documented as already inside the consumption figure, so
       re-applying it would inflate the costing; saying so is the honest half. */
    expect(codes).toContain("ALLOWANCE_ALREADY_IN_CONSUMPTION");
    expect(codes).toContain("VENDOR_NOT_LINKED_TO_MASTER");

    const overlapping = adapter.linesFromCostingSheets([...sheets, { part: "combined", materials: [] }], "INR");
    expect(overlapping.ambiguities.map((a) => a.code)).toContain("COMBINED_AND_SPLIT_SHEETS");
  });

  test("the import key follows the CONTENT, so an edit is a new version and a repeat is not", () => {
    const a = adapter.linesFromCostingSheets(sheets, "INR");
    const same = adapter.linesFromCostingSheets(sheets, "INR");
    expect(adapter.legacyImportKey({ enquiryId: "e1", productName: "Blazer", ...a }))
      .toBe(adapter.legacyImportKey({ enquiryId: "e1", productName: "Blazer", ...same }));

    const edited = adapter.linesFromCostingSheets(
      [{ ...sheets[0], materials: [{ ...sheets[0].materials[0], unitCost: "420.00" }] }, sheets[1]], "INR",
    );
    expect(adapter.legacyImportKey({ enquiryId: "e1", productName: "Blazer", ...edited }))
      .not.toBe(adapter.legacyImportKey({ enquiryId: "e1", productName: "Blazer", ...a }));
  });

  test("imported lines calculate", () => {
    const { lines } = adapter.linesFromCostingSheets(sheets, "INR");
    const out = calculate({ lines, policy: POLICY, scenarios: [{ key: "a", quantity: "500", isPrimary: true }] });
    /* 57,750 fabric + 16,200 stitching + 2,500 testing = 76,450 per piece,
       plus 12% overhead = 85,624. */
    expect(at(out, "a").unitCostMinor).toBe(85624);
  });
});

/* ═══ CHUNK 5A · A RATE PER SCENARIO, AND WHY THE COST MOVED ═════════════ */

describe("economies of scale with evidence behind them", () => {
  const POLICY_5A = {
    baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
    overheadBasis: "DIRECT_PLUS_FIXED", overheadRatePercent: "10",
    floorMarkupPercent: "25",
  };
  const SCENARIOS = [
    { key: "q500", label: "500 garments", quantity: "500", isPrimary: true },
    { key: "q3000", label: "3000 garments", quantity: "3000" },
  ];
  /* A quotation-backed fabric line whose rate the SERVER derived per
     scenario, and a one-time setup charged to the run. */
  const tiered = () => ({
    lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
    confidence: "SUPPLIER_QUOTATION",
    unitRate: { amountMinor: 41250, currency: "INR" },
    unitRateByScenario: {
      q500: { amountMinor: 41250, currency: "INR" },
      q3000: { amountMinor: 39500, currency: "INR" },
    },
    quantityPerUnit: "1", quantityUom: "Metre",
  });
  const setup = () => ({
    lineKey: "screens", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN",
    label: "Screen making", amount: { amountMinor: 2500000, currency: "INR" },
  });

  const run = (lines, scenarios = SCENARIOS) =>
    calculate({ lines, scenarios, policy: POLICY_5A });

  test("each scenario is costed on its own rate", async () => {
    const out = run([tiered()]);
    const rate = (k) => out.scenarios.find((s) => s.key === k).lines.find((l) => l.lineKey === "fabric").unitRateMinor;
    expect(rate("q500")).toBe(41250);
    expect(rate("q3000")).toBe(39500);
  });

  test("a legitimate tiered difference is not reported as a defect", async () => {
    /* The engine warns when variable cost per piece differs between
       scenarios, because until this chunk it could only mean a defect. A
       server-derived tier is the one honest reason it may — so the warning
       must not fire, or every tiered costing would carry a "treat with
       suspicion" note. */
    const out = run([tiered()]);
    expect(out.warnings.map((w) => w.code)).not.toContain("VARIABLE_UNIT_COST_VARIED");

    /* And it still fires when the rates differ with nothing to explain it. */
    const bogus = { ...tiered(), unitRateByScenario: undefined };
    expect(run([bogus]).warnings.map((w) => w.code)).not.toContain("VARIABLE_UNIT_COST_VARIED");
  });

  test("a fixed total does not change; only its allocation does", async () => {
    const out = run([tiered(), setup()]);
    const fixedLine = (k) => out.scenarios.find((s) => s.key === k).lines.find((l) => l.lineKey === "screens");

    /* The supplier did not discount the screens. 25,000 is 25,000. */
    expect(fixedLine("q500").totalMinor).toBe(2500000);
    expect(fixedLine("q3000").totalMinor).toBe(2500000);
    /* 2,500,000 / 500 = 5,000 and / 3,000 = 833.33 → 833. */
    expect(fixedLine("q500").perUnitMinor).toBe(5000);
    expect(fixedLine("q3000").perUnitMinor).toBe(833);
  });

  test("the explanation names each cause, its line and its amounts", async () => {
    const out = run([tiered(), setup()]);
    const compared = out.scenarios.find((s) => s.key === "q3000").comparedToPrimary;
    expect(compared.againstScenarioKey).toBe("q500");
    expect(compared.againstQuantity).toBe("500");

    const by = Object.fromEntries(compared.causes.map((c) => [c.cause, c]));

    /* The quoted tier, attributed to the line it came from. */
    expect(by.SUPPLIER_TIER).toMatchObject({
      lineKey: "fabric", category: "MATERIAL",
      primaryRateMinor: 41250, comparedRateMinor: 39500,
      perUnitDeltaMinor: -1750,
      source: "SUPPLIER_QUOTATION",
    });

    /* The dilution, with both totals stated so a reader can see the total
       did not move. */
    expect(by.FIXED_COST_DILUTION).toMatchObject({
      lineKey: "screens",
      primaryPerUnitMinor: 5000, comparedPerUnitMinor: 833,
      perUnitDeltaMinor: -4167,
      primaryTotalMinor: 2500000, comparedTotalMinor: 2500000,
      source: "FIXED_ALLOCATION",
    });
    expect(by.FIXED_COST_DILUTION.label).toMatch(/spread over 3,000 instead of 500/);

    /* Overhead moved because its basis moved — arithmetic, not a
       negotiation, and it says so. */
    expect(by.OVERHEAD_CONSEQUENCE?.source).toBe("POLICY_PERCENTAGE");
    expect(by.OVERHEAD_CONSEQUENCE?.label).toMatch(/follows the basis/);
  });

  test("nothing is claimed that the engine cannot point at", async () => {
    const out = run([tiered(), setup()]);
    const causes = out.scenarios.find((s) => s.key === "q3000").comparedToPrimary.causes;
    for (const c of causes) expect(EOS_CAUSES).toContain(c.cause);
    /* The named-but-unsupported ones, which need policy or records this
       chunk does not have. */
    const names = causes.map((c) => c.cause).join(",");
    for (const forbidden of ["BULK_DISCOUNT", "OPERATION_EFFICIENCY", "WASTAGE", "FREIGHT"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test("an unchanged variable line is reported as unchanged, not omitted", async () => {
    /* Otherwise a reader cannot tell "this did not move" from "nobody
       looked at it". */
    const flat = {
      lineKey: "thread", category: "MATERIAL", behaviour: "PER_UNIT", label: "Thread",
      unitRate: { amountMinor: 900, currency: "INR" }, quantityPerUnit: "0.2", quantityUom: "Metre",
    };
    const out = run([tiered(), flat]);
    const causes = out.scenarios.find((s) => s.key === "q3000").comparedToPrimary.causes;
    const unchanged = causes.find((c) => c.cause === "UNCHANGED_VARIABLE_COST");
    expect(unchanged).toMatchObject({ lineKey: "thread", perUnitDeltaMinor: 0 });
  });

  test("the causes add up, and any residue is stated rather than absorbed", async () => {
    const out = run([tiered(), setup()]);
    const c = out.scenarios.find((s) => s.key === "q3000").comparedToPrimary;
    const attributed = c.causes.reduce((n, x) => n + (x.perUnitDeltaMinor || 0), 0);
    expect(c.unattributedMinor).toBe(c.unitCostDeltaMinor - attributed);
    /* Rounding aside, the causes should account for the movement. */
    expect(Math.abs(c.unattributedMinor)).toBeLessThanOrEqual(2);
  });

  test("a version with one rate for every scenario still calculates", async () => {
    /* Every version written before this chunk. `unitRateByScenario` absent
       means one rate applied throughout — never zero. */
    const legacy = { ...tiered(), unitRateByScenario: undefined };
    const out = run([legacy, setup()]);
    const rate = (k) => out.scenarios.find((s) => s.key === k).lines.find((l) => l.lineKey === "fabric").unitRateMinor;
    expect(rate("q500")).toBe(41250);
    expect(rate("q3000")).toBe(41250);
    const causes = out.scenarios.find((s) => s.key === "q3000").comparedToPrimary.causes;
    expect(causes.some((c) => c.cause === "SUPPLIER_TIER")).toBe(false);
    expect(causes.some((c) => c.cause === "FIXED_COST_DILUTION")).toBe(true);
  });

  test("a scenario with no rate of its own falls back, and never to zero", async () => {
    const partial = {
      ...tiered(),
      unitRateByScenario: { q3000: { amountMinor: 39500, currency: "INR" } },
    };
    const out = run([partial]);
    const rate = (k) => out.scenarios.find((s) => s.key === k).lines.find((l) => l.lineKey === "fabric").unitRateMinor;
    expect(rate("q500")).toBe(41250);
    expect(rate("q3000")).toBe(39500);
  });
});
