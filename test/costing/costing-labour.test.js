// test/costing/costing-labour.test.js
//
// WHAT A MINUTE OF SEWING COSTS, AND WHY THE OLD ANSWER WAS TOO LOW.
//
// `operationCosting.js` computes `net salary / 12,480 x SAM`. It is the
// stock-item editor's own formula and right for what that screen does. As a
// COSTING it makes three unstated claims: that every paid minute is
// productive, that an operator costs their take-home pay, and that machines
// are free. The first two understate labour — usually the second-largest
// number in a garment costing — by a third or more between them.
//
// These prove the company's own assumptions now move the figure, rather than
// changing a status label beside an unchanged one.
"use strict";

const labour = require("../../services/centralCosting/labourCost");

/* 26 days x 8 hours x 60 = the PAID minutes in a month. Efficiency is applied
   to it; it is no longer assumed to be the productive month. */
const PAID = 12480;

const BASE = Object.freeze({ samMinutes: 1.5, netSalaryPerMonth: 18000 });
const FULL = Object.freeze({
  productiveMinutesPerMonth: 9000,
  employerBurdenPercent: "18",
  machineBurdenTreatment: "IN_OVERHEAD",
});

const cost = (policy, over = {}) =>
  labour.labourCostPerGarment({ ...BASE, ...over, policy });

describe("labour cost from the company's own assumptions", () => {
  test("the worked example", () => {
    /* 18,000 net x 1.18 employer burden = 21,240 employer cost per month.
       21,240 / 9,000 productive minutes  = 2.36 per productive minute.
       2.36 x 1.5 SAM                     = 3.54 per garment. */
    const r = cost(FULL);
    expect(r.ok).toBe(true);
    expect(r.workings.employerCostPerMonth).toBe("21240.00");
    expect(r.workings.costPerMinute).toBe("2.360000");
    expect(r.amountMinor).toBe(354);

    /* The old formula: 18,000 / 12,480 x 1.5 = 2.16. It is 39% lower, and the
       difference is the employer burden and the unproductive minutes nobody
       was accounting for. */
    expect(Math.round((18000 / PAID) * 1.5 * 100)).toBe(216);
  });

  test("changing productive minutes changes the cost", () => {
    const tight = cost({ ...FULL, productiveMinutesPerMonth: 7000 });
    const loose = cost({ ...FULL, productiveMinutesPerMonth: 11000 });
    expect(tight.amountMinor).toBe(455);
    expect(loose.amountMinor).toBe(290);
    /* Fewer productive minutes means each one carries more of the salary. */
    expect(tight.amountMinor).toBeGreaterThan(cost(FULL).amountMinor);
    expect(loose.amountMinor).toBeLessThan(cost(FULL).amountMinor);
  });

  test("changing efficiency changes the cost", () => {
    const at70 = cost({ labourEfficiencyPercent: "70", employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD" });
    const at85 = cost({ labourEfficiencyPercent: "85", employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD" });
    /* 12,480 x 70% = 8,736 productive minutes; 21,240 / 8,736 x 1.5 = 3.65. */
    expect(at70.amountMinor).toBe(365);
    expect(at85.amountMinor).toBe(300);
    /* A company at 85% has a labour cost a fifth below one at 70% — which is
       exactly the difference a default would have buried. */
    expect(at85.amountMinor).toBeLessThan(at70.amountMinor);
  });

  test("changing employer burden changes the cost", () => {
    const none = cost({ ...FULL, employerBurdenPercent: "0" });
    const heavy = cost({ ...FULL, employerBurdenPercent: "35" });
    expect(none.amountMinor).toBe(300);
    expect(heavy.amountMinor).toBe(405);
    expect(heavy.amountMinor).toBeGreaterThan(none.amountMinor);
  });

  test("SAM still drives it, from the R&D record", () => {
    expect(cost(FULL, { samMinutes: 3 }).amountMinor).toBe(708);
    expect(cost(FULL, { samMinutes: 0.75 }).amountMinor).toBe(177);
  });

  /* ── AND WHAT IT REFUSES TO GUESS ────────────────────────────────────── */

  test("two productive bases are a contradiction, not a preference", () => {
    /* 9,000 minutes and 80% efficiency say 9,000 and 9,984. Silently
       preferring either buries a disagreement inside every labour rate. */
    const r = cost({ ...FULL, labourEfficiencyPercent: "80" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("PRODUCTIVE_BASIS_AMBIGUOUS");
    expect(r.message).toMatch(/two answers to one question/i);
  });

  test("no assumptions means no rate, not the old rate", () => {
    for (const policy of [
      {},
      { employerBurdenPercent: "18" },
      { productiveMinutesPerMonth: 9000 },
    ]) {
      const r = cost(policy);
      expect(r.ok).toBe(false);
      expect(r.amountMinor).toBeUndefined();
    }
  });

  test("a missing SAM or salary is refused, never costed at zero", () => {
    expect(cost(FULL, { samMinutes: 0 }).reason).toBe("SAM_NOT_RECORDED");
    expect(cost(FULL, { netSalaryPerMonth: null }).reason).toBe("SALARY_BASIS_UNRESOLVED");
    expect(cost(FULL, { netSalaryPerMonth: 0 }).reason).toBe("SALARY_BASIS_UNRESOLVED");
  });

  test("an enum is not a machine-cost source", () => {
    /* "Inside the operation rate" states an intention and supplies no number:
       nothing in this repository records a machine hourly rate, a
       depreciation schedule or a power rate. Treating the family as answered
       because the field is set is the failure this checks for. */
    const inRate = labour.machineBurden({ machineBurdenTreatment: "IN_OPERATION_RATE" });
    expect(inRate.resolved).toBe(false);
    expect(inRate.message).toMatch(/no machine-cost source exists/i);

    /* These two ARE answers: overhead carries a rate, and "not costed" is a
       decision somebody made. */
    expect(labour.machineBurden({ machineBurdenTreatment: "IN_OVERHEAD" }).resolved).toBe(true);
    expect(labour.machineBurden({ machineBurdenTreatment: "NOT_COSTED" }).resolved).toBe(true);
    expect(labour.machineBurden({}).resolved).toBe(false);
  });

  test("the workings are returned so the number can be checked", () => {
    const r = cost(FULL);
    expect(r.workings).toMatchObject({
      samMinutes: "1.5",
      netSalaryPerMonth: "18000",
      employerBurdenPercent: "18",
      productiveMinutesPerMonth: "9000.00",
      productiveBasis: "STATED_MINUTES",
      machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(r.workings.productiveBasisLabel).toMatch(/9000 productive minutes per month/);

    const eff = cost({ labourEfficiencyPercent: "70", employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD" });
    expect(eff.workings.productiveBasis).toBe("EFFICIENCY");
    expect(eff.workings.productiveBasisLabel).toMatch(/70% of 12,480 paid minutes/);
  });
});
