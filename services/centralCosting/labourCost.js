"use strict";
/**
 * services/centralCosting/labourCost.js
 *
 * WHAT A MINUTE OF SEWING ACTUALLY COSTS THE COMPANY.
 *
 * ── THE FORMULA THIS REPLACES ───────────────────────────────────────────────
 * `services/operationCosting.js` computes `net salary / 12,480 × SAM`, where
 * 12,480 is 26 days × 8 hours × 60. It is the stock-item editor's own formula
 * and it is right for what that screen does — but as a COSTING it makes three
 * unstated claims:
 *
 *   1. every paid minute is a productive minute. No line balancing loss, no
 *      changeover, no absence, no rework. Real garment lines run at 45–75%,
 *      so an unadjusted rate under-states labour by a third or more;
 *   2. the operator costs what they take home. PF, ESI, gratuity, bonus and
 *      leave encashment are simply absent;
 *   3. machines are free, or somebody else is paying for them.
 *
 * None of the three can be guessed — a company at 55% efficiency and one at
 * 85% have labour costs a third apart, and picking a "reasonable" default puts
 * that difference into every quotation silently. So they are company settings,
 * and until they exist this module refuses to produce a rate rather than
 * producing the old one and calling it costed.
 *
 * ── THE FORMULA ─────────────────────────────────────────────────────────────
 *
 *     employer cost per month = net salary × (1 + employer burden %)
 *     productive minutes      = stated minutes, OR 12,480 × efficiency %
 *     cost per minute         = employer cost per month ÷ productive minutes
 *     labour cost per garment = cost per minute × SAM
 *
 * Exact decimal throughout; rounded once, at the end, by the policy's own
 * rounding rule — so a rate derived here and a total computed by the engine
 * cannot round differently.
 */

const { Decimal, roundMinor } = require("./decimal");

/* 26 working days × 8 hours × 60. The same constant `operationCosting.js`
   uses, named here because it is now a DENOMINATOR OF PAID minutes that
   efficiency is applied to, rather than an assumed productive month. */
const PAID_MINUTES_PER_MONTH = 26 * 8 * 60; // 12,480

const present = (v) => v !== null && v !== undefined && v !== "";

const REASON = Object.freeze({
  NO_ASSUMPTIONS: "PRODUCTION_ASSUMPTIONS_NOT_CONFIGURED",
  BOTH_BASES: "PRODUCTIVE_BASIS_AMBIGUOUS",
  NO_SALARY: "SALARY_BASIS_UNRESOLVED",
  NO_SAM: "SAM_NOT_RECORDED",
  MACHINE_SOURCE_MISSING: "MACHINE_COST_SOURCE_MISSING",
});

/**
 * Is the company's production policy usable, and which basis does it state?
 *
 * ── BOTH IS A CONTRADICTION, NOT A PREFERENCE ───────────────────────────────
 * `productiveMinutesPerMonth` and `labourEfficiencyPercent` are two answers to
 * one question. A company that has set 9,000 minutes AND 80% has said 9,000
 * and 9,984, and silently preferring either would bury a disagreement inside
 * every labour rate. It is refused so somebody resolves it once, in the
 * policy, rather than never.
 */
function productiveBasis(policy = {}) {
  const minutes = present(policy.productiveMinutesPerMonth)
    ? new Decimal(String(policy.productiveMinutesPerMonth)) : null;
  const efficiency = present(policy.labourEfficiencyPercent)
    ? new Decimal(String(policy.labourEfficiencyPercent)) : null;

  if (minutes && efficiency) {
    return {
      ok: false,
      reason: REASON.BOTH_BASES,
      message: "The costing policy states both productive minutes and a labour efficiency. They are two answers to one question — keep whichever the company actually measures.",
    };
  }
  if (minutes) {
    if (!minutes.isFinite() || minutes.isLessThanOrEqualTo(0)) {
      return { ok: false, reason: REASON.NO_ASSUMPTIONS, message: "Productive minutes per month must be positive." };
    }
    return { ok: true, minutes, basis: "STATED_MINUTES", describe: `${minutes.toFixed()} productive minutes per month` };
  }
  if (efficiency) {
    if (!efficiency.isFinite() || efficiency.isLessThanOrEqualTo(0) || efficiency.isGreaterThan(100)) {
      return { ok: false, reason: REASON.NO_ASSUMPTIONS, message: "Labour efficiency is a percentage above zero and at most 100." };
    }
    return {
      ok: true,
      minutes: new Decimal(PAID_MINUTES_PER_MONTH).multipliedBy(efficiency).dividedBy(100),
      basis: "EFFICIENCY",
      describe: `${efficiency.toFixed()}% of ${PAID_MINUTES_PER_MONTH.toLocaleString("en-IN")} paid minutes`,
    };
  }
  return {
    ok: false,
    reason: REASON.NO_ASSUMPTIONS,
    message: "The company has not stated how much of a paid month is productive.",
  };
}

/**
 * Whether machine cost is answered, and by what.
 *
 * ── AN ENUM IS NOT A SOURCE ─────────────────────────────────────────────────
 * `IN_OPERATION_RATE` says machine cost is inside the labour rate. Nothing in
 * this repository records a machine hourly cost, a depreciation schedule or a
 * power rate — so choosing that value states an intention and supplies no
 * number, and treating the family as answered because the enum is set would
 * be the exact "resolved because a field exists" failure this chunk is
 * correcting.
 *
 * `IN_OVERHEAD` IS an answer: the overhead policy carries it, and that policy
 * has a rate. `NOT_COSTED` is an answer too — a deliberate one, recorded.
 */
function machineBurden(policy = {}) {
  const treatment = policy.machineBurdenTreatment || null;
  if (!treatment) {
    return { resolved: false, treatment: null, reason: REASON.MACHINE_SOURCE_MISSING,
      message: "The company has not said where machine cost sits." };
  }
  if (treatment === "IN_OPERATION_RATE") {
    return {
      resolved: false,
      treatment,
      reason: REASON.MACHINE_SOURCE_MISSING,
      /* Named precisely, because the fix is a Production master, not a policy
         edit — and a person who has just set the policy needs to know that. */
      message: "Machine cost is set to sit inside the operation rate, but no machine-cost source exists to put there. Record machine rates, or charge machine cost through overhead.",
    };
  }
  return { resolved: true, treatment, reason: null, message: null };
}

/**
 * One operation's labour cost per garment, in integer minor units.
 *
 * Returns `{ ok: false, reason, message }` rather than a number whenever an
 * assumption is missing. A labour cost is not the kind of thing to approximate:
 * it is usually the second-largest number in a garment costing.
 */
function labourCostPerGarment({ samMinutes, netSalaryPerMonth, policy = {}, roundingMode = "HALF_UP" } = {}) {
  const sam = present(samMinutes) ? new Decimal(String(samMinutes)) : null;
  if (!sam || !sam.isFinite() || sam.isLessThanOrEqualTo(0)) {
    return { ok: false, reason: REASON.NO_SAM, message: "This operation has no recorded time." };
  }
  const salary = present(netSalaryPerMonth) ? new Decimal(String(netSalaryPerMonth)) : null;
  if (!salary || !salary.isFinite() || salary.isLessThanOrEqualTo(0)) {
    return { ok: false, reason: REASON.NO_SALARY, message: "No salary basis resolved for this operation." };
  }

  const basis = productiveBasis(policy);
  if (!basis.ok) return { ok: false, reason: basis.reason, message: basis.message };

  if (!present(policy.employerBurdenPercent)) {
    return {
      ok: false,
      reason: REASON.NO_ASSUMPTIONS,
      message: "The company has not stated its employer burden, so an operator's cost is only their take-home pay.",
    };
  }
  const burden = new Decimal(String(policy.employerBurdenPercent));
  if (!burden.isFinite() || burden.isNegative()) {
    return { ok: false, reason: REASON.NO_ASSUMPTIONS, message: "Employer burden is a percentage of zero or more." };
  }

  /* Exact until the single rounding point. */
  const employerCost = salary.multipliedBy(new Decimal(100).plus(burden)).dividedBy(100);
  const perMinute = employerCost.dividedBy(basis.minutes);
  const perGarmentRupees = perMinute.multipliedBy(sam);
  const amountMinor = roundMinor(perGarmentRupees.multipliedBy(100), roundingMode);

  return {
    ok: true,
    amountMinor,
    /* Everything a reader needs to check the number without recomputing it. */
    workings: {
      samMinutes: sam.toFixed(),
      netSalaryPerMonth: salary.toFixed(),
      employerBurdenPercent: burden.toFixed(),
      employerCostPerMonth: employerCost.toFixed(2),
      productiveMinutesPerMonth: basis.minutes.toFixed(2),
      productiveBasis: basis.basis,
      productiveBasisLabel: basis.describe,
      costPerMinute: perMinute.toFixed(6),
      machineBurdenTreatment: policy.machineBurdenTreatment || null,
    },
  };
}

/** Everything about the policy that stops a labour rate being costed. */
function assumptionGaps(policy = {}) {
  const gaps = [];
  const basis = productiveBasis(policy);
  if (!basis.ok) gaps.push({ reason: basis.reason, message: basis.message });
  if (!present(policy.employerBurdenPercent)) {
    gaps.push({
      reason: REASON.NO_ASSUMPTIONS,
      message: "The company has not stated its employer burden, so an operator's cost is only their take-home pay.",
    });
  }
  const machine = machineBurden(policy);
  if (!machine.resolved) gaps.push({ reason: machine.reason, message: machine.message });
  return gaps;
}

module.exports = {
  PAID_MINUTES_PER_MONTH, REASON,
  productiveBasis, machineBurden, labourCostPerGarment, assumptionGaps,
};
