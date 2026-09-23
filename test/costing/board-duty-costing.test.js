// test/costing/board-duty-costing.test.js
//
// THE BOARD'S DUTY TABLE, MEETING A REAL COSTING.
//
// ── WHAT THIS PROVES THAT THE POLICY SUITE CANNOT ───────────────────────────
// The policy suite proves the table's own rules. This proves what a COSTING
// does with them: that a domestic input is charged nothing and says so, that
// each of the three desks' missing facts blocks with that desk named, that an
// explicit 0% produces a real line, and that duty lands in its own category
// rather than inside the material or under `MISC`.
//
// ── AND THAT IT IS NOT GST ──────────────────────────────────────────────────
// Non-recoverable input GST is added onto the line it sits on. Customs duty is
// a separate line in a separate category. They are different taxes on
// different events, and a costing that merged them could answer neither
// "what did duty cost us" nor "what tax could we not reclaim".
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const { calculate } = require("../../services/centralCosting/engine");
const dutyPolicy = require("../../services/centralCosting/dutyPolicy.service");
const sourcingEvidence = require("../../services/storePurchase/sourcingEvidence.service");

/* One approved table: woven trousers from China at 10%, and the same heading
   from Bangladesh at an explicit 0%. */
const TABLE = {
  _id: "board-policy-1",
  effectiveFrom: new Date("2026-01-01"),
  approvedAt: new Date("2025-12-15"),
  approvedByActorName: "R. Menon",
  dutyRules: [
    {
      key: "6204-42-cn", label: "Woven trousers — China",
      customsTariffCode: "6204.42", countryOfOrigin: "CN",
      ratePercent: "10", effectiveFrom: new Date("2026-01-01"), active: true,
    },
    {
      key: "6204-42-bd", label: "Woven trousers — Bangladesh",
      customsTariffCode: "6204.42", countryOfOrigin: "BD",
      ratePercent: "0", effectiveFrom: new Date("2026-01-01"), active: true,
    },
  ],
};

const AT = new Date("2026-06-01");
const imported = (over = {}) => ({
  sourcingType: "IMPORTED", countryOfOrigin: "CN",
  customsTariffCode: "6204.42", dutyInQuotedRate: "EXCLUDED", ...over,
});

/* ═══ 1 · DOMESTIC IS AN ANSWER, NOT AN ABSENCE ═══════════════════════════ */

describe("domestic goods", () => {
  test("are charged nothing, and say so from Store's own evidence", () => {
    const p = dutyPolicy.positionFor({ sourcingType: "DOMESTIC" }, TABLE, { asOf: AT });
    expect(p.state).toBe("NOT_APPLICABLE");
    expect(p.blocking).toBe(false);
    expect(p.owner).toBeNull();
    expect(p.message).toMatch(/no customs entry/);
  });

  test("need no tariff heading and no origin — there is nothing to classify", () => {
    /* A domestic supply with no heading on the item master is complete. Asking
       for one would be a field whose only correct answer is "not applicable". */
    const p = dutyPolicy.positionFor(
      { sourcingType: "DOMESTIC", customsTariffCode: "", countryOfOrigin: "" },
      TABLE, { asOf: AT },
    );
    expect(p.state).toBe("NOT_APPLICABLE");
    expect(p.blocking).toBe(false);
  });

  test("and a domestic answer does NOT settle the separate input-GST question", () => {
    /* ── TWO TAXES, ONE FAMILY ────────────────────────────────────────
       `duty` covers customs AND non-recoverable GST. Store saying a supply is
       domestic answers the first completely and the second not at all — the
       position carries no GST opinion of any kind. */
    const p = dutyPolicy.positionFor({ sourcingType: "DOMESTIC" }, TABLE, { asOf: AT });
    expect(p).not.toHaveProperty("inputGstTreatment");
    expect(p).not.toHaveProperty("taxTreatment");
    expect(JSON.stringify(p)).not.toMatch(/GST|RECOVERABLE/);
  });
});

/* ═══ 2 · EACH MISSING FACT BLOCKS, NAMING ITS DESK ═══════════════════════ */

describe("an imported input with an incomplete record", () => {
  const cases = [
    ["no sourcing type at all", {}, "SOURCING_TYPE_MISSING", "Store / Purchase"],
    ["imported, no origin", imported({ countryOfOrigin: "" }), "ORIGIN_MISSING", "Store / Purchase"],
    ["imported, no tariff heading", imported({ customsTariffCode: "" }), "TARIFF_CODE_MISSING", "Store / Purchase"],
    ["imported, duty inclusion unknown", imported({ dutyInQuotedRate: "" }), "DUTY_INCLUSION_UNKNOWN", "Store / Purchase"],
  ];
  test.each(cases)("%s blocks and names its owner", (_name, evidence, state, department) => {
    const p = dutyPolicy.positionFor(evidence, TABLE, { asOf: AT });
    expect(p.state).toBe(state);
    expect(p.blocking).toBe(true);
    expect(p.owner.department).toBe(department);
  });

  test("no Board table blocks and names the Board, not Store", () => {
    const p = dutyPolicy.positionFor(imported(), null, { asOf: AT });
    expect(p.state).toBe("POLICY_MISSING");
    expect(p.owner.department).toBe("Board");
  });

  test("a complete record with no matching rule names the Board", () => {
    const p = dutyPolicy.positionFor(imported({ customsTariffCode: "9999.99" }), TABLE, { asOf: AT });
    expect(p.state).toBe("NO_MATCHING_RULE");
    expect(p.owner.department).toBe("Board");
    expect(p.message).toMatch(/not a rate of nil/);
  });

  test("an unanswered sourcing question is never read as domestic", () => {
    /* The specific mistake that turns a missing fact into a free one. */
    const p = dutyPolicy.positionFor({}, TABLE, { asOf: AT });
    expect(p.state).not.toBe("NOT_APPLICABLE");
    expect(p.message).toMatch(/not a domestic supply/);
  });
});

/* ═══ 3 · A DUTY THAT IS ALREADY IN THE RATE IS NOT CHARGED TWICE ═════════ */

describe("duty already inside the quoted rate", () => {
  test("is recorded as considered, and adds no second charge", () => {
    const p = dutyPolicy.positionFor(imported({ dutyInQuotedRate: "INCLUDED" }), TABLE, { asOf: AT });
    expect(p.state).toBe("NOT_APPLICABLE");
    expect(p.blocking).toBe(false);
    expect(p.dutyInQuotedRate).toBe("INCLUDED");
    expect(p.message).toMatch(/not added again/);
  });

  test("and the freight terms are NOT read as an answer to it", () => {
    /* `INCLUSIVE_LANDED` says the rate delivers to our warehouse. It says
       nothing about customs, and reading it as though it did is exactly how a
       landed rate ends up duty-charged twice. */
    const evidence = sourcingEvidence.assess(
      { _id: "o1", revision: 2, freightTerms: "INCLUSIVE_LANDED",
        sourcing: { type: "IMPORTED", countryOfOrigin: "CN" } },
      { _id: "i1", name: "Twill", customsTariffCode: "6204.42" },
    );
    expect(evidence.missing.map((m) => m.field)).toContain("sourcing.dutyInQuotedRate");
  });

  test("and the version FREEZES why there is no duty line, rather than omitting one", () => {
    /* ── THE DEFECT THIS CLOSES ────────────────────────────────────────
       An absent duty line has two innocent explanations and one guilty one:
       the goods were domestic, the rate already carried the duty, or nobody
       ever looked. A costing that simply had no line could not be told apart
       from one done before customs existed in this system, so the position is
       written down with no amount — because none was charged. */
    const p = dutyPolicy.positionFor(imported({ dutyInQuotedRate: "INCLUDED" }), TABLE, { asOf: AT });
    const frozen = dutyPolicy.freeze({
      resolved: { policy: null }, position: p,
      evidence: { quotation: { offerId: "o1", reference: "Q-9", revision: 3 } },
      scenarios: [], asOf: AT,
    });
    expect(frozen.dutyInQuotedRate).toBe("INCLUDED");
    /* No rate and no working, because nothing was computed. */
    expect(frozen.ratePercent).toBeNull();
    expect(frozen.scenarios).toEqual([]);
    /* And the reason, in words, so the record explains itself. */
    expect(frozen.note).toMatch(/already includes customs duty/);
    /* Traceable to the paper that said so. */
    expect(frozen.offerReference).toBe("Q-9");
    expect(frozen.offerRevision).toBe(3);
  });

  test("a DOMESTIC position is not written as an included-duty one", () => {
    /* Two different answers that both produce no line. Reading one as the
       other would claim the supplier priced customs into a purchase that
       never crossed a border. */
    const p = dutyPolicy.positionFor({ sourcingType: "DOMESTIC" }, TABLE, { asOf: AT });
    expect(p.state).toBe("NOT_APPLICABLE");
    expect(p.dutyInQuotedRate).toBeUndefined();
    expect(p.message).toMatch(/no customs entry/);
  });
});

/* ═══ 4 · ONE RULE, AND EXACT ARITHMETIC ══════════════════════════════════ */

describe("an imported input with exactly one effective rule", () => {
  test("is charged the rule's rate on the purchase amount", () => {
    const p = dutyPolicy.positionFor(imported(), TABLE, { asOf: AT });
    expect(p.state).toBe("APPLIED");
    expect(p.ratePercent).toBe("10");
    expect(p.rule.key).toBe("6204-42-cn");
    /* 100 units x 1 x Rs100 = 1,000,000 minor; 10% = 100,000. */
    expect(dutyPolicy.dutyMinorOn(1000000, "10")).toBe(100000);
  });

  test("the arithmetic is exact decimal, rounded once on the run total", () => {
    /* 12.5% of 333,333 is 41,666.625 — rounded once, not accumulated per unit. */
    expect(dutyPolicy.dutyMinorOn(333333, "12.5")).toBe(41667);
    expect(dutyPolicy.dutyMinorOn(1, "33.333")).toBe(0);
  });

  test("an explicit 0% rule produces a recorded nil, distinct from missing", () => {
    const p = dutyPolicy.positionFor(imported({ countryOfOrigin: "BD" }), TABLE, { asOf: AT });
    expect(p.state).toBe("ZERO_RATED");
    expect(p.blocking).toBe(false);
    /* The rule is named, which is what makes it evidence rather than silence. */
    expect(p.rule.key).toBe("6204-42-bd");
    expect(dutyPolicy.dutyMinorOn(1000000, p.ratePercent)).toBe(0);
    /* And it is NOT the state a missing rule produces. */
    expect(p.state).not.toBe("NO_MATCHING_RULE");
  });
});

/* ═══ 5 · THE ENGINE PUTS IT IN ITS OWN CATEGORY ══════════════════════════ */

describe("the duty line in a calculated costing", () => {
  const POLICY = {
    baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
    /* The pricing rule this engine policy prices under: one markup, since the
       three-band model was retired. This suite is about DUTY, so the figure
       only has to be present and stated. */
    floorMarkupPercent: "25",
  };
  const SCEN = [
    { key: "q100", label: "100", quantity: "100", isPrimary: true },
    { key: "q500", label: "500", quantity: "500" },
  ];
  const run = () => calculate({
    policy: POLICY,
    lines: [
      { lineKey: "m1", category: "MATERIAL", behaviour: "PER_UNIT", quantityPerUnit: "1",
        unitRate: { amountMinor: 10000, currency: "INR" }, confidence: "VERIFIED" },
      { lineKey: "duty:m1", category: "DUTY", behaviour: "FIXED_PER_RUN",
        label: "Customs duty — Twill",
        amount: { amountMinor: dutyPolicy.dutyMinorOn(1000000, "10"), currency: "INR" },
        amountByScenario: {
          q100: { amountMinor: dutyPolicy.dutyMinorOn(1000000, "10"), currency: "INR" },
          q500: { amountMinor: dutyPolicy.dutyMinorOn(5000000, "10"), currency: "INR" },
        },
        confidence: "VERIFIED" },
    ],
    scenarios: SCEN,
  });

  test("lands in DUTY, never inside the material and never under MISC", () => {
    const r = run();
    const cats = r.scenarios[0].categorySubtotals.map((c) => c.category);
    expect(cats).toContain("DUTY");
    expect(cats).not.toContain("MISC");
    /* The material is untouched — duty did not inflate the rate it was
       charged on. */
    const material = r.scenarios[0].categorySubtotals.find((c) => c.category === "MATERIAL");
    expect(material.totalMinor).toBe(1000000);
  });

  test("scales with the run, because the purchase amount does", () => {
    const r = run();
    const duty = (key) => r.scenarios.find((s) => s.key === key)
      .categorySubtotals.find((c) => c.category === "DUTY").totalMinor;
    expect(duty("q100")).toBe(100000);
    expect(duty("q500")).toBe(500000);
  });

  test("and DUTY is a different category from NON_RECOVERABLE_TAX", () => {
    /* Both are "tax that stays with the company" and they are not the same
       charge. The engine keeps two categories; this test keeps them two. */
    const { CATEGORIES } = require("../../services/centralCosting/engine");
    expect(CATEGORIES).toContain("DUTY");
    expect(CATEGORIES).toContain("NON_RECOVERABLE_TAX");
    expect(CATEGORIES.indexOf("DUTY")).not.toBe(CATEGORIES.indexOf("NON_RECOVERABLE_TAX"));
  });
});

/* ═══ 6 · WHAT A VERSION FREEZES ══════════════════════════════════════════ */

describe("frozen duty provenance", () => {
  const frozenFor = (evidence, policy = TABLE) => {
    const position = dutyPolicy.positionFor(evidence, policy, { asOf: AT });
    return dutyPolicy.freeze({
      resolved: { policy },
      position,
      evidence: { quotation: { offerId: "offer-1", reference: "Q-77", revision: 4 } },
      scenarios: [{ scenarioKey: "q100", basisAmountMinor: 1000000, dutyMinor: 100000 }],
      asOf: AT,
    });
  };

  test("records all three desks' facts, and the base it charged on", () => {
    const f = frozenFor(imported());
    expect(f).toMatchObject({
      state: "APPLIED", policyKey: "DUTY_POLICY",
      ruleKey: "6204-42-cn", customsTariffCode: "6204.42", countryOfOrigin: "CN",
      ratePercent: "10",
      /* Said explicitly, so no reader mistakes this for a statutory customs
         computation — see `dutyPolicy.service` for why CIF is not available. */
      assessableBasis: "QUOTATION_PURCHASE_AMOUNT",
      offerId: "offer-1", offerReference: "Q-77", offerRevision: 4,
      dutyInQuotedRate: "EXCLUDED",
    });
    expect(f.policyApprovedByName).toBe("R. Menon");
    expect(f.policyEffectiveFrom).toEqual(TABLE.effectiveFrom);
    expect(f.scenarios).toEqual([{ scenarioKey: "q100", basisAmountMinor: 1000000, dutyMinor: 100000 }]);
  });

  test("a zero-rated line freezes the RULE, so nil is evidence and not silence", () => {
    const f = frozenFor(imported({ countryOfOrigin: "BD" }));
    expect(f.state).toBe("ZERO_RATED");
    expect(f.ruleKey).toBe("6204-42-bd");
    expect(f.ratePercent).toBe("0");
  });

  test("a frozen entry is a copy — a later table cannot reach it", () => {
    const f = frozenFor(imported());
    /* The Board doubles the rate afterwards. */
    const later = { ...TABLE, dutyRules: [{ ...TABLE.dutyRules[0], ratePercent: "20" }] };
    const now = dutyPolicy.positionFor(imported(), later, { asOf: AT });
    expect(now.ratePercent).toBe("20");
    expect(f.ratePercent).toBe("10");
  });

  test("it carries no supplier rate — the basis amount is what a reader needs", () => {
    const f = frozenFor(imported());
    expect(f).not.toHaveProperty("unitRate");
    expect(f).not.toHaveProperty("supplierRate");
    expect(f).not.toHaveProperty("supplierName");
  });
});

/* ═══ 7 · THE FINGERPRINT SEES CHANGES WITHOUT PUBLISHING RATES ═══════════ */

describe("freshness detection", () => {
  const fingerprint = require("../../services/centralCosting/sourceFingerprint.service");
  const dp = (over = {}) => ({
    dutiedLineKey: "m1", customsTariffCode: "6204.42", countryOfOrigin: "CN",
    ruleKey: "6204-42-cn", offerId: "o1", offerRevision: 3,
    dutyInQuotedRate: "EXCLUDED", ratePercent: "10", ...over,
  });
  const tokenFor = (over) => fingerprint
    .partsFor({ assembled: { dutyProvenance: [dp(over)] } })
    .find((p) => p.key === "duty:m1").token;

  test("a changed rule, heading, origin, quotation or revision all move it", () => {
    const baseToken = tokenFor({});
    for (const change of [
      { ruleKey: "other" }, { customsTariffCode: "6204.43" }, { countryOfOrigin: "BD" },
      { offerId: "o2" }, { offerRevision: 4 }, { dutyInQuotedRate: "INCLUDED" },
    ]) {
      expect([Object.keys(change)[0], tokenFor(change)]).not.toEqual([Object.keys(change)[0], baseToken]);
    }
  });

  test("but the RATE never reaches the token", () => {
    /* Sales is entitled to know the customs position moved. What it moved TO
       is the Board's, and a token carrying it would put a policy value into a
       Sales response by the back door. */
    expect(tokenFor({})).not.toMatch(/10/);
    expect(tokenFor({ ratePercent: "97" })).toBe(tokenFor({ ratePercent: "10" }));
  });
});

/* ═══ 8 · LANE A'S WORK IS UNTOUCHED ══════════════════════════════════════ */

test("no Sales preparation or authorisation file references the duty policy", () => {
  /* Lane A owns the Sales estimate path and the `costing.prepare` correction.
     This lane added a Board policy and a cost line; it must not have reached
     into either. */
  const fs = require("fs");
  for (const f of [
    "services/sales/costingPreparation.service.js",
    "services/sales/costingResult.service.js",
    "services/centralCosting/capabilities.js",
  ]) {
    const src = fs.readFileSync(f, "utf8");
    expect([f, /DUTY_POLICY|dutyPolicy\.service/.test(src)]).toEqual([f, false]);
  }
});

test("Sales gains no tariff, rate or supplier-rate visibility", () => {
  /* The Sales projection is Lane A's and unchanged. Asserted from this side
     because the duty work is what could have widened it. */
  const fs = require("fs");
  const src = fs.readFileSync("services/sales/costingResult.service.js", "utf8");
  expect(src).not.toMatch(/customsTariffCode|countryOfOrigin|ratePercent.*duty|dutyProvenance/);
});

/* ═══ 8 · AND THE SHARED FIXTURE STATES ITS ANSWER, RATHER THAN LUCKING INTO IT ══ */

describe("the shared source-backed fixture's sourcing baseline", () => {
  /* ── WHY THIS IS TESTED AT ALL ──────────────────────────────────────────
     Making an unanswered sourcing question BLOCK is the whole point of this
     lane, and the moment it did, every fixture in this folder that had a
     packaging supplier stopped preparing — the fabric offer stated its
     sourcing and the poly bag's did not. The fix was to state it, once, in
     the shared helper. This pins the shape so a later edit cannot quietly
     drop it and leave the suites passing for the wrong reason, and pins that
     the missing case is still reachable ON PURPOSE. */
  const { sourcingFor } = require("./helpers/sourceBacked");

  test("a stated domestic supply is a sub-document, not an absence", () => {
    expect(sourcingFor("DOMESTIC")).toEqual({ sourcing: { type: "DOMESTIC" } });
  });

  test("an import carries the origin and the duty-inclusion answer", () => {
    expect(sourcingFor("IMPORTED", { countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" }))
      .toEqual({ sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" } });
  });

  test("an import missing either fact keeps it missing rather than inventing one", () => {
    /* The blocking cases the duty suites assert against have to be seedable.
       A helper that defaulted an origin or an inclusion answer would make
       every one of those tests pass against data no Store user entered. */
    expect(sourcingFor("IMPORTED", { countryOfOrigin: "" }).sourcing.countryOfOrigin).toBeUndefined();
    expect(sourcingFor("IMPORTED", { countryOfOrigin: "CN" }).sourcing.dutyInQuotedRate).toBeUndefined();
  });

  test("and NOT ANSWERING writes no sourcing at all — the shape of an old offer", () => {
    /* Deliberate, and only reachable by asking for it. This is what an offer
       written before Store was asked looks like, and it must stay expressible
       or the blocking rule has nothing to block. */
    expect(sourcingFor(null)).toEqual({});
    expect(sourcingFor("")).toEqual({});
  });
});
