"use strict";
/**
 * services/storePurchase/serviceOfferApplicability.js
 *
 * WHICH SERVICE QUOTATIONS CAN PRICE THIS WORK, AND WHY THE REST CANNOT.
 *
 * ── WHAT IS SHARED, AND WHAT IS NOT ─────────────────────────────────────────
 * The quantity arithmetic — minimum order, order multiple, which tier a
 * quantity reaches and whether ANY tier covers it — is the same commercial
 * question for a service as for a material, and it is imported rather than
 * copied. Two implementations of "does 1,400 reach the 1,000 tier" is how a
 * picker and a save end up disagreeing about one quotation.
 *
 * What is NOT shared is the unit. A material's purchase UoM is a stock unit
 * with a conversion factor in the Unit Master; a service's billing unit is
 * per visit, per lot, per kg of dry weight — deliberately outside that master,
 * for the reason `Service.billingUnit` gives. So there is no conversion here:
 * the requirement's unit must be the quotation's unit, and where it is not,
 * that is a refusal rather than a factor to look up. Inventing an equivalence
 * between "per piece" and "per lot" is a hundredfold error.
 *
 * ── AND WHAT A SERVICE HAS THAT A MATERIAL HAS NOT ──────────────────────────
 * A minimum charge: a floor under the line TOTAL rather than under the
 * quantity ordered. It never excludes a quotation — a 200-piece lot against a
 * ₹5,000 minimum is perfectly quotable, it simply costs ₹5,000 — so it is
 * reported as an applied fact, not as an exclusion.
 */

const BigNumber = require("bignumber.js");
const { EXCLUSIONS, checkQuantity } = require("./offerApplicability");

const present = (v) => v !== null && v !== undefined && v !== "";
const id = (v) => (present(v) ? String(v) : null);
const sameUnit = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * One quotation, judged against one requirement at one quantity.
 *
 * Ordered the way a person would ask: whose record is it, is it about this
 * service, is it alive, does the clock allow it, is the supplier still there,
 * and only then the quantity. Reporting "below the minimum lot" for a
 * withdrawn quotation would send somebody to renegotiate a price that no
 * longer exists.
 */
function evaluate(offer, criteria = {}, facts = {}) {
  const out = {
    offerId: id(offer._id ?? offer.offerId),
    supplierId: id(offer.supplierId),
    supplierName: offer.supplierName || "",
    quotationReference: offer.quotationReference || null,
    revision: offer.revision ?? 1,
    billingUnit: offer.billingUnit || null,
    currency: offer.currency || null,
  };
  const no = (code, message, extra = {}) => ({ ...out, applicable: false, code, message, ...extra });

  /* Belt and braces behind a scoped query. If this fires, the caller handed us
     another company's row and this is the last thing between it and a costing. */
  if (id(offer.companyId) && id(criteria.companyId) && id(offer.companyId) !== id(criteria.companyId)) {
    return no(EXCLUSIONS.WRONG_COMPANY, "That quotation belongs to another company.");
  }
  if (id(criteria.serviceId) && id(offer.serviceId) !== id(criteria.serviceId)) {
    return no(EXCLUSIONS.WRONG_ITEM, "This quotation is for a different service.");
  }

  if (offer.status === "DRAFT") {
    return no(EXCLUSIONS.NOT_PUBLISHED, "This quotation is still a draft, so it is not a price yet.");
  }
  if (offer.status === "WITHDRAWN") {
    return no(EXCLUSIONS.WITHDRAWN,
      offer.withdrawalReason
        ? `This quotation was withdrawn: ${offer.withdrawalReason}`
        : "This quotation was withdrawn.");
  }
  if (offer.status === "SUPERSEDED") {
    return no(EXCLUSIONS.SUPERSEDED, "A later revision replaced this quotation.", {
      supersededByOfferId: id(offer.supersededByOfferId),
    });
  }

  /* The clock is a parameter: a costing dated in June resolves the quotation
     that was in force in June, never whatever is in force when this runs. */
  const asOf = criteria.asOf instanceof Date ? criteria.asOf : new Date(criteria.asOf || Date.now());
  const from = offer.effectiveFrom ? new Date(offer.effectiveFrom) : null;
  if (from && from.getTime() > asOf.getTime()) {
    return no(EXCLUSIONS.NOT_YET_EFFECTIVE,
      `This quotation takes effect on ${from.toISOString().slice(0, 10)}, after the costing date.`,
      { effectiveFrom: from });
  }
  const until = offer.validUntil ? new Date(offer.validUntil) : null;
  if (until && until.getTime() < asOf.getTime()) {
    return no(EXCLUSIONS.EXPIRED,
      `This quotation expired on ${until.toISOString().slice(0, 10)}.`, { validUntil: until });
  }

  /* A live quotation from a supplier somebody deactivated is not a price you
     may cost against, and the record has no way to know. `null` means the
     caller did not look, and an unchecked fact is never treated as a pass. */
  if (facts.supplierActive && facts.supplierActive(id(offer.supplierId)) === false) {
    return no(EXCLUSIONS.INACTIVE_SUPPLIER, `${offer.supplierName || "That supplier"} is no longer active.`);
  }
  /* The Service master DOES have a lifecycle, unlike RawItem — so unlike the
     material resolver, this one can and does check it. */
  if (facts.serviceActive === false) {
    return no(EXCLUSIONS.INACTIVE_ITEM, "That service is no longer active in the Service Master.");
  }

  /* ── THE UNIT IS MATCHED, NEVER CONVERTED ──────────────────────────────── */
  if (!present(criteria.requestedUnit) || !present(offer.billingUnit)) {
    return no(EXCLUSIONS.INCOMPATIBLE_UOM,
      "The unit this work is measured in is not recorded, so a quotation cannot be applied to it.");
  }
  if (!sameUnit(offer.billingUnit, criteria.requestedUnit)) {
    return no(EXCLUSIONS.INCOMPATIBLE_UOM,
      `This quotation is per ${offer.billingUnit}, and the requirement is measured in ${criteria.requestedUnit}. Service billing units are not convertible.`,
      { billingUnit: offer.billingUnit, requestedUnit: criteria.requestedUnit });
  }

  /* ── MOQ, ORDER MULTIPLE AND TIER COVERAGE, FROM THE SHARED RULE ────────
     `checkQuantity` speaks the material register's field names, so the
     service's own are mapped onto them here. One rule, named twice, rather
     than two rules that will diverge. */
  const asMaterial = {
    offerId: out.offerId,
    purchaseUom: offer.billingUnit,
    moq: offer.minQuantity,
    orderMultiple: offer.orderMultiple,
    tiers: offer.tiers,
    unitPriceMinor: offer.unitPriceMinor,
  };
  const verdict = checkQuantity(asMaterial, String(criteria.quantity ?? ""));
  if (!verdict.ok) return no(verdict.code, verdict.message, verdict.details);
  const tier = verdict.tier;

  /* ── THE MINIMUM CHARGE IS APPLIED, NOT AN EXCLUSION ──────────────────── */
  const quantity = new BigNumber(String(criteria.quantity));
  const lineBeforeMinimum = new BigNumber(String(tier.unitPriceMinor)).multipliedBy(quantity);
  const minimum = present(offer.minimumChargeMinor)
    ? new BigNumber(String(offer.minimumChargeMinor)) : null;
  const minimumApplied = Boolean(minimum && lineBeforeMinimum.isLessThan(minimum));

  return {
    ...out,
    applicable: true,
    code: null,
    message: null,
    serviceQuantity: quantity.toFixed(),
    appliedUnitPriceMinor: tier.unitPriceMinor,
    priceSource: tier.source,
    tierMinQuantity: tier.minQuantity,
    tierMaxQuantity: tier.maxQuantity,
    tierNote: tier.note || null,
    /* Both figures, so a reader can see the floor doing its work rather than
       an unexplained total. */
    lineBeforeMinimumMinor: lineBeforeMinimum.integerValue(BigNumber.ROUND_HALF_UP).toNumber(),
    minimumChargeMinor: minimum ? minimum.toNumber() : null,
    minimumChargeApplied: minimumApplied,
    priceBasis: offer.priceBasis || null,
    gstRatePercent: present(offer.gstRatePercent) ? offer.gstRatePercent : null,
    sacCode: offer.sacCode || null,
    minQuantity: present(offer.minQuantity) ? offer.minQuantity : null,
    orderMultiple: present(offer.orderMultiple) ? offer.orderMultiple : null,
    leadTimeDays: present(offer.leadTimeDays) ? offer.leadTimeDays : null,
    effectiveFrom: offer.effectiveFrom || null,
    validUntil: offer.validUntil || null,
  };
}

/**
 * Split a list of quotations into the ones that can price this work and the
 * ones that cannot, each with its reason.
 *
 * Ordered by supplier name, then reference, then id — stable, and deliberately
 * NOT by price. A cheapest-first list is a recommendation, and this module does
 * not make one.
 */
function resolveApplicableServiceOffers({ offers = [], criteria = {}, facts = {} } = {}) {
  const evaluated = offers.map((o) => evaluate(o, criteria, facts));
  const byName = (a, b) =>
    String(a.supplierName || "").localeCompare(String(b.supplierName || ""))
    || String(a.quotationReference || "").localeCompare(String(b.quotationReference || ""))
    || String(a.offerId || "").localeCompare(String(b.offerId || ""));

  const applicable = evaluated.filter((e) => e.applicable).sort(byName);
  const excluded = evaluated.filter((e) => !e.applicable).sort(byName);
  return { applicable, excluded };
}

module.exports = { EXCLUSIONS, evaluate, resolveApplicableServiceOffers };
