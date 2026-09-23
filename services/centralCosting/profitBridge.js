// services/centralCosting/profitBridge.js
//
// FROM AN ESTIMATED COST TO AN ESTIMATED AFTER-TAX PROFIT.
//
//     Selling price excluding GST
//   − Estimated full cost
//   = Estimated pre-tax profit
//   − Estimated income tax on positive profit
//   = Estimated after-tax profit
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It is not a second calculator. The engine already produced the full cost,
// the category subtotals, the fixed-cost dilution and the policy prices; this
// takes `unitCostMinor` and a PROPOSED selling price and does the five lines
// above. Nothing here can change a cost.
//
// ── AND WHY INCOME TAX IS NOT IN THE COST ───────────────────────────────────
// A product's cost is what it takes to make and deliver it. Income tax is a
// charge on the company's profit for a period, computed across every product,
// every other income and expense, carried-forward losses and statutory
// adjustments. Putting it in the cost would mean the cost of a shirt changed
// when an unrelated order made a loss, and — worse — the number would then
// feed the margin policy, so the company would price to recover a tax it has
// not yet incurred on a profit it has not yet made.
//
// So it sits AFTER the profit line, applied only to a positive one, and is
// labelled an estimate everywhere it appears. It is not the company's
// statutory liability and this module never claims to compute one.
//
// ── MARKUP AND MARGIN ARE DIFFERENT NUMBERS ─────────────────────────────────
// On a ₹200 cost, a 25% MARKUP is ₹250; a 25% MARGIN is ₹266.67. People say
// one and mean the other constantly, so both are returned, both are labelled,
// and neither is called "profit percent".
//
//   markup = (price − cost) / cost        · profit as a share of what it cost
//   margin = (price − cost) / price       · profit as a share of what it sold for

"use strict";

const { Decimal, roundMinor, dec } = require("./decimal");

/* ── WHERE A PROPOSED PRICE SITS AGAINST THE COMPANY'S FLOOR ───────────────
 *
 * THREE ACTIVE STANDINGS, and only three. A price is at or above the floor, it
 * is below it, or there is no approved policy to judge it by. `BELOW_FLOOR` is
 * the one that means somebody has to decide something; publishing it is this
 * module's job, and acting on it is not — no approval workflow is implemented
 * here or consulted by anything.
 *
 * The three band standings below it are RETIRED and kept only so a version
 * frozen under the old policy still reads back what it froze. Nothing new
 * produces one. */
const STANDING = Object.freeze({
  AT_OR_ABOVE_FLOOR: "AT_OR_ABOVE_FLOOR",
  BELOW_FLOOR: "BELOW_FLOOR",
  /* No approved pricing policy, so there is nothing to judge it against. A
     price cannot clear a floor that does not exist, and this is emphatically
     not "fine". */
  POLICY_MISSING: "POLICY_MISSING",

  /* ── RETIRED: THE THREE-BAND VOCABULARY ───────────────────────────── */
  BELOW_MINIMUM: "BELOW_MINIMUM",
  WITHIN_POLICY: "WITHIN_POLICY",
  MEETS_TARGET: "MEETS_TARGET",
  NO_POLICY: "NO_POLICY",
});

/* The three a NEW version may carry. Pinned as data so a test can assert the
   active vocabulary without listing it by hand and drifting from it. */
const ACTIVE_STANDINGS = Object.freeze([
  STANDING.AT_OR_ABOVE_FLOOR, STANDING.BELOW_FLOOR, STANDING.POLICY_MISSING,
]);

const STANDING_LABEL = Object.freeze({
  AT_OR_ABOVE_FLOOR: "At or above the floor price",
  BELOW_FLOOR: "Below the floor price — management approval required",
  POLICY_MISSING: "No approved pricing policy, so this price cannot be judged",

  BELOW_MINIMUM: "Below the minimum margin this company allows",
  WITHIN_POLICY: "Within policy, below the target margin",
  MEETS_TARGET: "Meets the target margin",
  NO_POLICY: "No margin band is configured, so this price cannot be judged",
});

/**
 * Where a proposed price stands against a floor.
 *
 * Equal to the floor is AT_OR_ABOVE: a floor is the lowest acceptable price,
 * not a price to beat. A missing floor is never "above" — nothing has been
 * cleared, and saying otherwise would let a costing with no policy read as
 * compliant.
 */
function standingAgainstFloor(proposedPriceMinor, floorPriceMinor) {
  if (floorPriceMinor === null || floorPriceMinor === undefined) {
    return { standing: STANDING.POLICY_MISSING, standingLabel: STANDING_LABEL.POLICY_MISSING };
  }
  return Number(proposedPriceMinor) >= Number(floorPriceMinor)
    ? { standing: STANDING.AT_OR_ABOVE_FLOOR, standingLabel: STANDING_LABEL.AT_OR_ABOVE_FLOOR }
    : { standing: STANDING.BELOW_FLOOR, standingLabel: STANDING_LABEL.BELOW_FLOOR };
}

/* Why a number is unavailable. Never conflated with zero: a costing that
   cannot say its after-tax profit and one that says the profit is nil are
   different answers, and only the second is a result. */
const UNAVAILABLE = Object.freeze({
  NO_PRICE: "NO_PROPOSED_PRICE",
  NO_TAX_RATE: "NO_INCOME_TAX_RATE",
  NO_COST: "NO_COST",
});

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * Markup and margin for one cost and price.
 *
 * Both returned as decimal strings to four places, because a percentage
 * carried as a float is a percentage that stops adding up.
 */
function ratios(unitCostMinor, priceMinor) {
  const cost = new Decimal(unitCostMinor);
  const price = new Decimal(priceMinor);
  const profit = price.minus(cost);
  return {
    /* Profit as a share of what it cost. Undefined at zero cost — dividing by
       nothing is not "infinite markup", it is a question with no answer. */
    markupPercent: cost.isZero() ? null : profit.dividedBy(cost).multipliedBy(100).decimalPlaces(4).toFixed(),
    /* Profit as a share of what it sold for. Undefined at zero price. */
    marginPercent: price.isZero() ? null : profit.dividedBy(price).multipliedBy(100).decimalPlaces(4).toFixed(),
  };
}

/**
 * Where a price sits against the configured band.
 *
 * Judged on MARGIN, because that is what the policy is expressed in and what
 * `priceFor` in the engine solves for. Comparing a margin figure against a
 * markup band would pass prices the company forbids.
 */
function standingOf(marginPercent, { minimumMarginPercent, targetMarginPercent }) {
  if (marginPercent === null) return { standing: STANDING.NO_POLICY, standingLabel: STANDING_LABEL.NO_POLICY };
  const min = present(minimumMarginPercent) ? new Decimal(minimumMarginPercent) : null;
  const target = present(targetMarginPercent) ? new Decimal(targetMarginPercent) : null;
  /* A band of zeroes is the unconfigured default, not a decision that every
     price is acceptable — `policy.configured` says which, and the caller
     passes nothing when it is false. */
  if (!min && !target) return { standing: STANDING.NO_POLICY, standingLabel: STANDING_LABEL.NO_POLICY };

  const m = new Decimal(marginPercent);
  if (min && m.isLessThan(min)) {
    return { standing: STANDING.BELOW_MINIMUM, standingLabel: STANDING_LABEL.BELOW_MINIMUM };
  }
  if (target && m.isGreaterThanOrEqualTo(target)) {
    return { standing: STANDING.MEETS_TARGET, standingLabel: STANDING_LABEL.MEETS_TARGET };
  }
  return { standing: STANDING.WITHIN_POLICY, standingLabel: STANDING_LABEL.WITHIN_POLICY };
}

/**
 * The whole bridge for one scenario.
 *
 * @param {object}  scenario   the engine's result — unitCostMinor, quantity
 * @param {number?} priceMinor the PROPOSED selling price per unit, excluding GST
 * @param {object}  policy     margin band and the estimated income-tax rate
 * @returns {object} the five lines, per unit and for the scenario
 */
function bridgeFor(scenario, priceMinor, policy = {}, { roundingMode = "HALF_UP" } = {}) {
  const quantity = new Decimal(scenario.quantity ?? scenario.quantityValue ?? 0);
  const unitCostMinor = scenario.unitCostMinor;
  const totalCostMinor = scenario.totalCostMinor;
  /* The scenario's own floor, where it has one. Read off the scenario rather
     than recomputed, so the standing is measured against the price this
     version actually published. */
  const floorPriceMinor = scenario.floor?.floorPriceMinor ?? null;

  const base = {
    scenarioKey: scenario.key,
    label: scenario.label || "",
    quantity: quantity.toFixed(),
    unitCostMinor: unitCostMinor ?? null,
    totalCostMinor: totalCostMinor ?? null,
    /* Carried so a reader sees the price the standing was judged against, not
       just the verdict. Null on a historical band scenario. */
    floorPriceMinor,
  };

  if (!present(unitCostMinor)) {
    return { ...base, available: false, unavailableReason: UNAVAILABLE.NO_COST };
  }
  /* ── NO PRICE IS NOT A ZERO PRICE ───────────────────────────────────────
     A scenario nobody has proposed a price for has no profit to report. A
     zero would render as a total loss of the entire cost, which is a
     confident claim about a decision nobody has made. */
  if (!present(priceMinor)) {
    return { ...base, available: false, unavailableReason: UNAVAILABLE.NO_PRICE };
  }

  const price = new Decimal(priceMinor);
  const cost = new Decimal(unitCostMinor);
  const preTaxUnitMinor = price.minus(cost);
  const preTaxTotalMinor = roundMinor(preTaxUnitMinor.multipliedBy(quantity), roundingMode);

  const { markupPercent, marginPercent } = ratios(unitCostMinor, priceMinor);
  /* ── JUDGED AGAINST THE FLOOR WHERE THERE IS ONE ────────────────────
     A scenario priced under the markup policy carries its floor, and that is
     what a proposed price is measured against. A historical scenario has no
     floor and keeps being judged by the band it was frozen with — recomputing
     it under the new policy would restate where a past quotation stood. */
  const { standing, standingLabel } = present(floorPriceMinor)
    ? standingAgainstFloor(priceMinor, floorPriceMinor)
    : standingOf(marginPercent, policy);

  /* ── INCOME TAX, ON POSITIVE PROFIT ONLY ────────────────────────────────
     A loss does not generate a tax refund on this product. Relief for a loss
     depends on the company's other income and on carry-forward rules, and
     showing a negative tax here would report a benefit nobody is owed —
     making a loss-making price look better than it is. */
  const taxable = preTaxUnitMinor.isGreaterThan(0) ? preTaxUnitMinor : new Decimal(0);
  const rate = present(policy.estimatedIncomeTaxRatePercent)
    ? new Decimal(policy.estimatedIncomeTaxRatePercent) : null;

  const taxUnitMinor = rate === null
    ? null
    : roundMinor(taxable.multipliedBy(rate).dividedBy(100), roundingMode);
  const taxTotalMinor = rate === null
    ? null
    : roundMinor(taxable.multipliedBy(rate).dividedBy(100).multipliedBy(quantity), roundingMode);

  return {
    ...base,
    available: true,
    unavailableReason: null,

    proposedPriceMinor: Number(price.toFixed()),
    /* What the whole run would invoice at this price, excluding GST. Computed
       here rather than left for a screen to multiply: money arithmetic stays
       on the server and on the same rounding contract as every other figure,
       and a blank beside the other four totals reads as a missing answer. */
    proposedRevenueTotalMinor: roundMinor(price.multipliedBy(quantity), roundingMode),
    /* Excluding GST, said in the field name because the whole answer is wrong
       if somebody enters a GST-inclusive figure here. */
    proposedPriceExcludesTax: true,

    preTaxProfitUnitMinor: roundMinor(preTaxUnitMinor, roundingMode),
    preTaxProfitTotalMinor: preTaxTotalMinor,

    markupPercent,
    marginPercent,
    standing,
    standingLabel,

    /* Null, never 0, when no rate is configured — "we have not been told the
       rate" and "the tax is nil" are different answers. */
    estimatedIncomeTaxRatePercent: rate === null ? null : rate.toFixed(),
    estimatedIncomeTaxUnitMinor: taxUnitMinor,
    estimatedIncomeTaxTotalMinor: taxTotalMinor,
    incomeTaxAvailable: rate !== null,
    incomeTaxUnavailableReason: rate === null ? UNAVAILABLE.NO_TAX_RATE : null,

    afterTaxProfitUnitMinor: taxUnitMinor === null
      ? null : roundMinor(preTaxUnitMinor.minus(taxUnitMinor), roundingMode),
    afterTaxProfitTotalMinor: taxTotalMinor === null
      ? null : preTaxTotalMinor - taxTotalMinor,
  };
}

/**
 * The bridge for every scenario, and the proposed prices it was built from.
 *
 * @param {Array}  scenarios      the engine's calculated scenarios
 * @param {Map|object} priceByKey proposed unit prices, keyed by scenario key
 */
function bridgeAll(scenarios = [], priceByKey = {}, policy = {}, opts = {}) {
  const lookup = priceByKey instanceof Map
    ? (k) => priceByKey.get(k)
    : (k) => priceByKey[k];
  return scenarios.map((s) => bridgeFor(s, lookup(s.key), policy, opts));
}

module.exports = {
  ACTIVE_STANDINGS, standingAgainstFloor,
  STANDING, STANDING_LABEL, UNAVAILABLE,
  ratios, standingOf, bridgeFor, bridgeAll,
};
