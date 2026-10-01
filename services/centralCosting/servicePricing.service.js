"use strict";
/**
 * services/centralCosting/servicePricing.service.js
 *
 * WHAT A REQUIRED PROCESS COSTS, FROM A DATED SERVICE QUOTATION.
 *
 * ── WHAT IS REUSED, AND WHY IT IS SAFE TO ───────────────────────────────────
 * `offerPricing.netRateMinor` and `offerPricing.taxPositionFor` take a
 * quotation's `priceBasis` and `gstRatePercent` and answer two questions that
 * are about TAX, not about materials: what the net of a tax-inclusive figure
 * is, and whether the company gets that GST back. A service quotation carries
 * exactly the same two fields with exactly the same meanings, so reusing them
 * is one rule named once — and a second copy would eventually disagree about
 * a tax-inclusive rate, which is a silent 18% error in one direction or the
 * other.
 *
 * `offerApplicability.checkQuantity` is reused through the service resolver
 * for the same reason: MOQ, order multiple and tier coverage are the same
 * arithmetic whatever is being bought.
 *
 * ── WHAT IS DELIBERATELY NOT REUSED ─────────────────────────────────────────
 * The unit conversion. A service's billing unit is not in the Unit Master and
 * has no factor to look up; the requirement's unit must BE the quotation's
 * unit, and where it is not that is a refusal. See `serviceOfferApplicability`.
 *
 * ── AND WHAT IS NEVER READ ──────────────────────────────────────────────────
 * `Service.defaultRate`, `ServiceOrder`, `SpendRequest`. None of the three is
 * imported by this file. The first is planning guidance by its own account;
 * the other two are downstream of a decision to buy, and a pre-production
 * costing exists before either of them does.
 */

const { Decimal, roundMinor } = require("./decimal");
const { fail } = require("../storePurchase/errors");
const offerPricing = require("./offerPricing.service");
const serviceOfferRead = require("../storePurchase/serviceOfferRead.service");
const storeFacts = require("./storeFacts.service");
const { checkQuantity } = require("../storePurchase/offerApplicability");

const present = (v) => v !== null && v !== undefined && v !== "";

const CODES = Object.freeze({
  NOT_USABLE: "COSTING_SERVICE_OFFER_NOT_USABLE",
  SUBJECT_MISMATCH: "COSTING_SERVICE_OFFER_SUBJECT_MISMATCH",
  UNIT_MISMATCH: "COSTING_SERVICE_UNIT_MISMATCH",
  QUANTITY_REQUIRED: "COSTING_SERVICE_QUANTITY_REQUIRED",
  INACTIVE_SUPPLIER: "COSTING_OFFER_INACTIVE_SUPPLIER",
  INACTIVE_SERVICE: "COSTING_SERVICE_INACTIVE",
  BELOW_MOQ: "COSTING_OFFER_BELOW_MOQ",
  NOT_AN_ORDER_MULTIPLE: "COSTING_OFFER_NOT_AN_ORDER_MULTIPLE",
  NO_QUANTITY_TIER: "COSTING_OFFER_NO_QUANTITY_TIER",
  CURRENCY_CONVERSION_REQUIRED: "COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED",
});

const QUANTITY_CODE = Object.freeze({
  BELOW_MOQ: CODES.BELOW_MOQ,
  NOT_AN_ORDER_MULTIPLE: CODES.NOT_AN_ORDER_MULTIPLE,
  NO_QUANTITY_TIER: CODES.NO_QUANTITY_TIER,
  QUANTITY_NOT_STATED: CODES.QUANTITY_REQUIRED,
});

const sameUnit = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * How much of the service the supplier is asked for, at one run size.
 *
 * PER_GARMENT scales with the run — 500 pieces washed is 500 washes. A fixed
 * charge does not: one screen-making job is one job whatever the order, and
 * multiplying it would order 500 of them. The dilution across the run is the
 * engine's arithmetic, not this one's.
 */
function serviceQuantityFor({ outputQuantity, basis, quantityPerUnit, quantityPerRun }) {
  const out = new Decimal(outputQuantity);
  if (!out.isFinite() || out.isLessThanOrEqualTo(0)) return null;
  return basis === "FIXED_PER_RUN"
    ? new Decimal(quantityPerRun)
    : out.multipliedBy(new Decimal(quantityPerUnit));
}

/**
 * One required service, priced from one selected quotation, per scenario.
 *
 * Returns the engine's shape plus everything a reader needs a year later to
 * say which quotation produced the figure — without the Service Master, the
 * supplier or the quotation still agreeing.
 */
async function resolveServiceRate(ctx, {
  serviceOfferId, serviceId, requestedUnit,
  basis = "PER_GARMENT", quantityPerUnit, quantityPerRun,
  evidence = null,
  scenarioQuantities = [], asOf = new Date(),
  costingCurrency, roundingMode = "HALF_UP",
  /* Only the RECOVERABILITY comes from the caller — whether the company gets
     this GST back is Finance's decision, and the quotation cannot state it.
     The RATE is the quotation's and the caller's is discarded. */
  taxTreatment = null,
} = {}) {
  const stated = basis === "FIXED_PER_RUN" ? quantityPerRun : quantityPerUnit;
  const q = new Decimal(present(stated) ? stated : 0);
  if (!q.isFinite() || q.isLessThanOrEqualTo(0)) {
    /* Zero is not "free" — it is a requirement nobody finished recording, and
       pricing it would report a process that costs nothing. */
    throw fail(CODES.QUANTITY_REQUIRED,
      basis === "FIXED_PER_RUN"
        ? "Say how much of this service the run needs, before a quotation can price it."
        : "Say how much of this service one finished piece needs, before a quotation can price it.",
      { basis, quantity: stated ?? null });
  }

  const readCtx = { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_service_pricing" };
  const offer = await serviceOfferRead.currentOfferById(readCtx, serviceOfferId);
  if (!offer) {
    throw fail(CODES.NOT_USABLE,
      "That service quotation is not this company's, so it cannot price a line.",
      { serviceOfferId });
  }
  /* Lifecycle and clock, judged against the COSTING date rather than now — a
     costing dated in June resolves what was in force in June. */
  const live = offer.status === "ACTIVE"
    && (!offer.effectiveFrom || new Date(offer.effectiveFrom).getTime() <= asOf.getTime())
    && (!offer.validUntil || new Date(offer.validUntil).getTime() >= asOf.getTime());
  if (!live) {
    throw fail(CODES.NOT_USABLE,
      offer.status === "WITHDRAWN" && offer.withdrawalReason
        ? `This quotation was withdrawn: ${offer.withdrawalReason}`
        : "That service quotation is not current for this costing date, so it cannot price a line.",
      { serviceOfferId, status: offer.status, validUntil: offer.validUntil, asOf });
  }

  if (String(offer.serviceId) !== String(serviceId)) {
    throw fail(CODES.SUBJECT_MISMATCH, "That quotation is for a different service.",
      { expectedServiceId: String(offer.serviceId) });
  }

  /* ── THE SUPPLIER AND THE SERVICE MUST BOTH STILL BE ALIVE ──────────────
     Neither fact is on the quotation, and both can change long after it was
     given. Deliberately NOT wrapped in a catch: these reads return null for
     absent-or-foreign and THROW for an outage, and calling a database blip
     "inactive" is a refusal that reads as a commercial decision. */
  const supplier = await storeFacts.supplierIdentity(readCtx, offer.supplierId);
  if (!supplier || String(supplier.status || "active").toLowerCase() !== "active") {
    throw fail(CODES.INACTIVE_SUPPLIER,
      `${offer.supplierName || "That supplier"} is no longer active, so their quotation cannot price a costing.`,
      { supplierId: offer.supplierId, supplierName: offer.supplierName });
  }
  const service = await storeFacts.serviceFacts(readCtx, serviceId);
  if (!service || !service.active) {
    throw fail(CODES.INACTIVE_SERVICE,
      "That service is no longer active in the Service Master.",
      { serviceId: String(serviceId) });
  }

  /* ── THE UNIT IS MATCHED, NEVER CONVERTED ─────────────────────────────── */
  if (!sameUnit(offer.billingUnit, requestedUnit)) {
    throw fail(CODES.UNIT_MISMATCH,
      `This quotation is per ${offer.billingUnit}, and the requirement is measured in ${requestedUnit || "nothing recorded"}. Service billing units are not convertible.`,
      { billingUnit: offer.billingUnit, requestedUnit: requestedUnit || null });
  }

  if (costingCurrency && offer.currency !== costingCurrency) {
    throw fail(CODES.CURRENCY_CONVERSION_REQUIRED,
      `This quotation is in ${offer.currency} and the costing is in ${costingCurrency}. No conversion rate is recorded.`,
      { offerCurrency: offer.currency, costingCurrency });
  }

  const outputs = (scenarioQuantities || [])
    .map((s_, i) => (typeof s_ === "object" && s_ !== null
      ? { key: String(s_.key ?? `q${i}`), quantity: Number(s_.quantity) }
      : { key: `q${i}`, quantity: Number(s_) }))
    .filter((s_) => Number.isFinite(s_.quantity) && s_.quantity > 0);
  if (!outputs.length) {
    throw fail(CODES.QUANTITY_REQUIRED,
      "A quotation-backed service line needs a run size, so the service quantity — and therefore the tier — can be worked out.",
      { serviceOfferId: offer.offerId });
  }

  /* The shared quantity rule, in the service register's own field names. */
  const asMaterial = {
    offerId: offer.offerId,
    purchaseUom: offer.billingUnit,
    moq: offer.minQuantity,
    orderMultiple: offer.orderMultiple,
    tiers: offer.tiers,
    unitPriceMinor: offer.unitPriceMinor,
  };

  const priced = outputs.map(({ key, quantity: outputQuantity }) => {
    const serviceQuantity = serviceQuantityFor({
      outputQuantity, basis, quantityPerUnit, quantityPerRun,
    });
    const shown = serviceQuantity ? serviceQuantity.toFixed() : null;
    const verdict = checkQuantity(asMaterial, shown === null ? "0" : shown);
    if (!verdict.ok) {
      return { scenarioKey: key, outputQuantity: String(outputQuantity), serviceQuantity: shown, verdict };
    }
    const tier = verdict.tier;
    const net = offerPricing.netRateMinor(
      { priceBasis: offer.priceBasis, gstRatePercent: offer.gstRatePercent, offerId: offer.offerId },
      tier.unitPriceMinor, roundingMode,
    );
    /* ── THE MINIMUM CHARGE, APPLIED TO THE LINE TOTAL ──────────────────
       "₹8 a piece, minimum ₹5,000" is a floor under the TOTAL, so it is
       applied after the quantity and before anything is divided back out.
       Applying it to the RATE instead would make a 200-piece lot cost ₹25 a
       piece and a 700-piece lot ₹8 — which is true, and is the consequence
       rather than the term. */
    const lineNetBefore = new Decimal(net.netMinor).multipliedBy(serviceQuantity);
    const minimum = present(offer.minimumChargeMinor)
      ? new Decimal(offer.minimumChargeMinor) : null;
    const minimumApplied = Boolean(minimum && lineNetBefore.isLessThan(minimum));
    const lineNet = minimumApplied ? minimum : lineNetBefore;

    return {
      scenarioKey: key,
      outputQuantity: String(outputQuantity),
      serviceQuantity: shown,
      verdict,
      source: tier.source,
      minQuantity: tier.minQuantity,
      maxQuantity: tier.maxQuantity ?? null,
      quotedAmountMinor: tier.unitPriceMinor,
      netRateMinor: net.netMinor,
      netRateDerived: net.derived,
      gstAmountMinor: net.gstAmountMinor,
      grossRateMinor: net.grossMinor,
      lineNetBeforeMinimumMinor: roundMinor(lineNetBefore, roundingMode),
      minimumChargeApplied: minimumApplied,
      lineNetMinor: roundMinor(lineNet, roundingMode),
      /* What the ENGINE multiplies. For a per-piece line that is a rate per
         finished garment, so the minimum charge is spread back across the
         run — the only honest way to express a floor as a per-unit figure,
         and the reason both numbers are frozen beside it. */
      effectiveRateMinor: roundMinor(lineNet.dividedBy(new Decimal(outputQuantity)), roundingMode),
    };
  });

  const blocked = priced.filter((p) => !p.verdict.ok);
  if (blocked.length) {
    const first = blocked[0].verdict;
    throw fail(
      QUANTITY_CODE[first.code] || CODES.NOT_USABLE,
      first.message,
      {
        ...(first.details || {}),
        serviceOfferId: offer.offerId,
        supplierId: offer.supplierId,
        supplierName: offer.supplierName,
        /* Which scenario, at what service quantity — a costing with several
           run sizes can fail on one and not the others. */
        scenarios: blocked.map((p) => ({
          scenarioKey: p.scenarioKey,
          outputQuantity: p.outputQuantity,
          serviceQuantity: p.serviceQuantity,
          code: p.verdict.code,
          message: p.verdict.message,
        })),
      },
    );
  }

  const tax = offerPricing.taxPositionFor(
    { priceBasis: offer.priceBasis, gstRatePercent: offer.gstRatePercent, offerId: offer.offerId },
    taxTreatment,
  );

  const applied = priced[0];

  return {
    currency: offer.currency,
    tax,
    /* A fixed charge reaches the engine as an amount for the run; a per-piece
       one as a rate per garment, with each scenario's own rate beside it. */
    ...(basis === "FIXED_PER_RUN"
      ? { fixedAmountMinor: applied.lineNetMinor }
      : {
        rateMinor: applied.effectiveRateMinor,
        ratesByScenario: Object.fromEntries(priced.map((p) => [
          p.scenarioKey, { amountMinor: p.effectiveRateMinor, currency: offer.currency },
        ])),
      }),
    provenance: {
      state: "SUPPLIER_QUOTATION",
      family: "SERVICE",
      offerId: offer.offerId,
      offerRevision: offer.revision,
      supplierId: offer.supplierId,
      supplierName: offer.supplierName,
      /* Snapshotted, so a version stays readable after a rename or a merge. */
      serviceId: String(serviceId),
      serviceCode: service.serviceCode,
      serviceName: service.name,
      supplierServiceCode: offer.supplierServiceCode,
      supplierServiceName: offer.supplierServiceName,
      ...(offer.document ? { document: { ...offer.document } } : {}),
      quotationReference: offer.quotationReference,
      quotationDate: offer.quotationDate || null,
      asOf,
      currency: offer.currency,
      quotedAmountMinor: applied.quotedAmountMinor,
      priceBasis: offer.priceBasis,
      sacCode: offer.sacCode || service.sacCode || null,
      gstRatePercent: present(offer.gstRatePercent) ? offer.gstRatePercent : null,
      gstRecorded: present(offer.gstRatePercent) || offer.priceBasis === "NON_TAXABLE",
      gstTreatment: tax.treatment,
      gstAmountMinor: applied.gstAmountMinor ?? null,
      grossRateMinor: applied.grossRateMinor ?? null,
      roundingMode,
      netRateMinor: applied.netRateMinor,
      netRateDerived: applied.netRateDerived,
      billingUnit: offer.billingUnit,
      requestedUnit,
      basis,
      /* Frozen beside the rate: a reader a year later must be able to see
         that the quantity was planned rather than measured, without the
         technical record still saying so. */
      evidence,
      ...(basis === "FIXED_PER_RUN"
        ? { quantityPerRun: String(quantityPerRun) }
        : { quantityPerUnit: String(quantityPerUnit) }),
      priceSource: applied.source,
      tierMinQuantity: applied.minQuantity,
      tierMaxQuantity: applied.maxQuantity,
      minimumChargeMinor: present(offer.minimumChargeMinor) ? offer.minimumChargeMinor : null,
      minimumChargeApplied: applied.minimumChargeApplied,
      minQuantity: offer.minQuantity,
      orderMultiple: offer.orderMultiple,
      leadTimeDays: offer.leadTimeDays,
      effectiveFrom: offer.effectiveFrom,
      validUntil: offer.validUntil,
      appliedServiceQuantity: applied.serviceQuantity,
      /* Each scenario's own commercial facts. Without these a version cannot
         answer "why was 3,000 cheaper" without the quotation still existing —
         which is exactly what a frozen version must not depend on. */
      scenarios: priced.map((p) => ({
        scenarioKey: p.scenarioKey,
        outputQuantity: p.outputQuantity,
        serviceQuantity: p.serviceQuantity,
        billingUnit: offer.billingUnit,
        priceSource: p.source,
        tierMinQuantity: p.minQuantity,
        tierMaxQuantity: p.maxQuantity,
        quotedAmountMinor: p.quotedAmountMinor,
        netRateMinor: p.netRateMinor,
        netRateDerived: p.netRateDerived,
        gstAmountMinor: p.gstAmountMinor,
        grossRateMinor: p.grossRateMinor,
        lineNetBeforeMinimumMinor: p.lineNetBeforeMinimumMinor,
        minimumChargeApplied: p.minimumChargeApplied,
        lineNetMinor: p.lineNetMinor,
        effectiveRateMinor: p.effectiveRateMinor,
        taxTreatment: tax.treatment,
      })),
    },
    warnings: [],
  };
}

module.exports = { CODES, serviceQuantityFor, resolveServiceRate };
