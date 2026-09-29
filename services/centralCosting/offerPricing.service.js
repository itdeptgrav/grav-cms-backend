"use strict";
/**
 * services/centralCosting/offerPricing.service.js
 *
 * Central Costing — Chunk 3.2. TURNING A SUPPLIER QUOTATION INTO A LINE RATE.
 *
 * ── THE CLIENT NAMES THE OFFER; THE SERVER DECIDES THE PRICE ────────────────
 * A costing line may submit `supplierOfferId`, the item, the variant and how
 * much is consumed. It may not submit a supplier name or a rate: a price the
 * browser supplied is a price nobody quoted, and it would be frozen into a
 * version as evidence.
 *
 * Everything below is re-read from the Store register through
 * `supplierOfferRead.service.js` and re-checked here — company, item, variant,
 * currency, validity, unit and tier. The screen's own checks are a courtesy.
 *
 * ── AND NOTHING IS INVENTED ─────────────────────────────────────────────────
 * No discount is interpolated between tiers. No unit conversion is guessed. No
 * currency is converted. Each of those is a number nobody declared, and each
 * would be frozen into a costing that reads as though somebody had.
 */

const offerRead = require("../storePurchase/supplierOfferRead.service");
const storeFacts = require("./storeFacts.service");
const { Decimal, roundMinor } = require("./decimal");
const { fail } = require("../storePurchase/errors");

/* ── STABLE REFUSAL CODES ────────────────────────────────────────────────────
 * A line that cannot be priced says WHY in a way the screen can render beside
 * the offer the person chose. "Invalid" would send them back to guess. */
const CODES = Object.freeze({
  OFFER_NOT_USABLE: "COSTING_OFFER_NOT_USABLE",
  OFFER_SUBJECT_MISMATCH: "COSTING_OFFER_SUBJECT_MISMATCH",
  CONVERSION_NOT_CONFIGURED: "COSTING_OFFER_CONVERSION_NOT_CONFIGURED",
  CURRENCY_CONVERSION_REQUIRED: "COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED",
  GST_NOT_RECORDED: "COSTING_OFFER_GST_NOT_RECORDED",
  /* ── RETIRED IN CHUNK 5A, KEPT AS A NAME ────────────────────────────────
     The engine carried one rate per line, so two scenarios reaching two
     quoted tiers had to be refused — which made the central economies-of-scale
     comparison impossible to calculate. `unitRateByScenario` removed the
     limit. The code is left declared so an old stored refusal still resolves
     to a name rather than to `undefined`; nothing raises it. */
  TIER_VARIES_BY_SCENARIO: "COSTING_OFFER_TIER_VARIES_BY_SCENARIO",
  LINE_NOT_ELIGIBLE: "COSTING_OFFER_LINE_NOT_ELIGIBLE",
  /* Tiers were quoted and none of them reaches this quantity. */
  NO_QUANTITY_TIER: "COSTING_OFFER_NO_QUANTITY_TIER",
  BELOW_MOQ: "COSTING_OFFER_BELOW_MOQ",
  NOT_AN_ORDER_MULTIPLE: "COSTING_OFFER_NOT_AN_ORDER_MULTIPLE",
  TAX_TREATMENT_REQUIRED: "COSTING_OFFER_TAX_TREATMENT_REQUIRED",
  TAX_TREATMENT_NOT_ALLOWED: "COSTING_OFFER_TAX_TREATMENT_NOT_ALLOWED",
  /* The quotation is live; the company behind it is not. */
  INACTIVE_SUPPLIER: "COSTING_OFFER_INACTIVE_SUPPLIER",
  CONSUMPTION_REQUIRED: "COSTING_OFFER_CONSUMPTION_REQUIRED",
  SCENARIO_QUANTITY_REQUIRED: "COSTING_OFFER_SCENARIO_QUANTITY_REQUIRED",
});

const present = (v) => v !== null && v !== undefined && v !== "";

/* ── ONLY ONE SHAPE OF LINE MAY BE PRICED THIS WAY, FOR NOW ─────────────────
 * A supplier quotation is a rate per purchase unit, and turning it into a
 * line cost needs a consumption per finished unit. A FIXED_PER_RUN line has
 * no per-unit consumption and a PERCENT_OF_BASIS line has no rate of its own,
 * so neither can be priced from a quotation without inventing the missing
 * half. Refused by name rather than mis-priced. */
/* Both families are bought from the item master against a supplier quotation.
   Packaging joined when the technical record gained a packaging requirement;
   before that there was nothing to price and the narrower list was accurate. */
const QUOTABLE_CATEGORIES = Object.freeze(["MATERIAL", "PACKAGING"]);
const QUOTABLE_BEHAVIOURS = Object.freeze(["PER_UNIT", "FIXED_PER_RUN", "PER_CARTON"]);

function assertEligible({ category, behaviour, quantityPerUnit, quantityPerRun }) {
  if (!QUOTABLE_CATEGORIES.includes(category)) {
    throw fail(CODES.LINE_NOT_ELIGIBLE,
      "Only a material or packaging line can be priced from a supplier quotation.",
      { category, allowed: [...QUOTABLE_CATEGORIES] });
  }
  if (!QUOTABLE_BEHAVIOURS.includes(behaviour)) {
    throw fail(CODES.LINE_NOT_ELIGIBLE,
      "Only a per-piece or fixed-per-run line can be priced from a quotation — a percentage line has no quantity to price.",
      { behaviour, allowed: [...QUOTABLE_BEHAVIOURS] });
  }

  /* ── A FIXED LINE IS QUOTED ON THE RUN'S QUANTITY, NOT THE PIECE'S ──────
     A master carton holding forty garments is bought per ORDER: thirteen
     cartons for a 500-piece run, and the same thirteen however the cost is
     divided afterwards. Multiplying it by the run size the way a per-piece
     line is multiplied would order 6,500 of them.

     So a fixed line states `quantityPerRun` and a per-piece line states
     `quantityPerUnit`, and neither is read for the other. */
  /* A carton line states how many of the item ONE CARTON needs — almost
     always 1, but a double-walled export carton needing two liners is a real
     answer and is not derivable. It is read from `quantityPerUnit` because
     that is the "per one of the thing this is counted in" field; what makes
     it a carton line is the behaviour, which decides how many of that thing
     a run contains. */
  const stated = behaviour === "FIXED_PER_RUN" ? quantityPerRun : quantityPerUnit;
  const field = behaviour === "FIXED_PER_RUN" ? "quantityPerRun" : "quantityPerUnit";
  const q = new Decimal(present(stated) ? stated : 0);
  if (!q.isFinite() || q.isLessThanOrEqualTo(0)) {
    /* Zero is not "free" — it is a line nobody finished entering, and pricing
       it would report a material or a carton that costs nothing. */
    throw fail(CODES.CONSUMPTION_REQUIRED,
      behaviour === "FIXED_PER_RUN"
        ? "Say how much of this is needed for the run, before a quotation can price it."
        : "Say how much of this one finished piece uses, before a quotation can price it.",
      { [field]: stated ?? null });
  }
  return q;
}

/**
 * How much the SUPPLIER is being asked for, in the unit they quoted in.
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
 * Tiers, MOQ and order multiples were checked against the FINISHED-GOODS
 * quantity: 500 garments compared against a quotation whose tiers are in
 * metres. A 500-metre tier looked satisfied by 500 garments, and a 1,000-metre
 * minimum looked unmet by a run that in fact needs 700 metres — so the wrong
 * tier was applied and the warnings were about the wrong number entirely.
 *
 *   500 garments × 1.4 metre/garment = 700 metres of consumption
 *   700 metres ÷ (metres per purchase unit) = the supplier quantity
 *
 * Exact decimal throughout: 1.4 in binary floating point is not 1.4, and a
 * tier boundary is exactly where that shows.
 */
function purchaseQuantityFor({
  outputQuantity, quantityPerUnit, conversionFactor,
  behaviour = "PER_UNIT", quantityPerRun, garmentsPerCarton,
}) {
  const out = new Decimal(outputQuantity);
  if (!out.isFinite() || out.isLessThanOrEqualTo(0)) return null;

  /* ── A CARTON STEPS; IT NEITHER SCALES NOR STAYS FIXED ─────────────────
     501 garments at 25 to a carton is 21 cartons, not 20.04 and not 20. The
     twenty-first is bought whole and is charged whole, which is the same
     ceiling rule `sample.shipment.garmentsPerCarton` documents and the
     freight family already applies. A part carton does not exist to buy. */
  if (behaviour === "PER_CARTON") {
    const perCarton = new Decimal(present(garmentsPerCarton) ? garmentsPerCarton : 0);
    /* Refused upstream by the technical record; guarded again here because
       reading an absent conversion as 1 would buy one carton per garment. */
    if (!perCarton.isFinite() || perCarton.isLessThanOrEqualTo(0)) return null;
    const cartons = out.dividedBy(perCarton).integerValue(Decimal.ROUND_CEIL);
    const consumption = cartons.multipliedBy(new Decimal(quantityPerUnit));
    const factor = new Decimal(conversionFactor);
    if (!factor.isFinite() || factor.isLessThanOrEqualTo(0)) return null;
    return consumption.dividedBy(factor);
  }

  /* ── FIXED DOES NOT SCALE, WHICH IS THE WHOLE POINT ────────────────────
     The supplier is asked for the same quantity whatever the run size; what
     changes is how thinly it is spread, and that is the engine's arithmetic,
     not this one's. */
  const consumption = behaviour === "FIXED_PER_RUN"
    ? new Decimal(quantityPerRun)
    : out.multipliedBy(new Decimal(quantityPerUnit));
  const factor = new Decimal(conversionFactor);
  if (!factor.isFinite() || factor.isLessThanOrEqualTo(0)) return null;
  /* `factor` is how many CONSUMPTION units one PURCHASE unit yields, so the
     purchase quantity is the consumption divided by it. */
  return consumption.dividedBy(factor);
}

/* ── ONE QUANTITY RULE, SHARED WITH THE STORE ────────────────────────────────
 * MOQ, order multiple and tier coverage are decided by
 * `storePurchase/offerApplicability.checkQuantity`, which the Store's
 * applicability listing calls too. This module used to keep its own tier
 * lookup and turn MOQ and order-multiple failures into WARNINGS — so the
 * picker could mark a supplier unusable while the save accepted it, and a
 * costing could be built on a quantity the company cannot actually order.
 *
 * ── WHY THEY ARE REFUSALS NOW, NOT NOTES ────────────────────────────────────
 * The engine costs the quantity the line REQUIRES. Below a minimum order, or
 * off an order multiple, the company must buy MORE than that — and the cost of
 * the surplus, and whatever future benefit the leftover stock carries, is not
 * something this engine models. Pricing the required quantity anyway reports a
 * cost the company cannot achieve, with a warning nobody has to read.
 *
 * So it stops and says which scenario, and what supplier quantity it reached.
 * Modelling purchased surplus belongs to a later costing/inventory chunk.
 */
const { checkQuantity, tierFor } = require("../storePurchase/offerApplicability");

/** Map the shared rule's code onto this module's stable costing codes. */
const QUANTITY_CODE = Object.freeze({
  BELOW_MOQ: CODES.BELOW_MOQ,
  NOT_AN_ORDER_MULTIPLE: CODES.NOT_AN_ORDER_MULTIPLE,
  NO_QUANTITY_TIER: CODES.NO_QUANTITY_TIER,
  QUANTITY_NOT_STATED: CODES.SCENARIO_QUANTITY_REQUIRED,
});

/**
 * The NET commercial rate, from the quotation's own basis.
 *
 * ── AND THE ONE CASE THAT CANNOT BE ANSWERED ────────────────────────────────
 * A tax-INCLUSIVE quotation with no recorded GST rate has no derivable net
 * rate: the tax is inside the number and nobody said how much. Treating the
 * gross as the net over-costs by the tax; treating it as zero-rated
 * under-costs by the same. Refused, and the refusal names what is missing.
 *
 * This chunk establishes the supplier's commercial rate. Whether that GST is
 * recoverable is Finance's decision and is not made here.
 */
function netRateMinor(offer, quotedMinor, roundingMode = "HALF_UP") {
  if (offer.priceBasis === "TAX_EXCLUSIVE") {
    /* The quoted figure IS the net rate. */
    return { netMinor: quotedMinor, derived: false, gstAmountMinor: null, grossMinor: null };
  }
  /* ── A STATED NIL, WHICH IS NOT A MISSING RATE ─────────────────────────
     NON_TAXABLE is the supplier saying the supply carries no GST, so net,
     gross and quoted are one number and the tax is a recorded zero. An
     unrecorded rate on a tax-inclusive quotation is refused below; the two
     must not collapse into each other. */
  if (offer.priceBasis === "NON_TAXABLE") {
    return { netMinor: quotedMinor, derived: false, gstAmountMinor: 0, grossMinor: quotedMinor, gstRatePercent: 0 };
  }
  const rate = offer.gstRatePercent;
  if (!present(rate)) {
    throw fail(CODES.GST_NOT_RECORDED,
      "This quotation is tax-inclusive but records no GST rate, so its net rate cannot be worked out. Ask the supplier for the rate, or record the price excluding tax.",
      { offerId: offer.offerId, priceBasis: offer.priceBasis });
  }
  /* Exact decimal arithmetic, rounded ONCE by the policy's own rule — the
     same `roundMinor` the engine uses, so a net rate derived here and a total
     computed there cannot round differently. */
  const exact = new Decimal(quotedMinor).multipliedBy(100).dividedBy(new Decimal(100).plus(rate));
  const netMinor = roundMinor(exact, roundingMode);
  /* The tax that was inside the quoted figure. Reported and frozen so a
     reader can see the split without re-deriving it from a rate and a
     rounding rule that may have changed since. */
  return {
    netMinor, derived: true, gstRatePercent: rate,
    gstAmountMinor: quotedMinor - netMinor, grossMinor: quotedMinor,
  };
}

/**
 * The tax position of a quotation-backed line — decided by the SERVER.
 *
 * ── THE RATE IS THE SUPPLIER'S; THE RECOVERABILITY IS THE COMPANY'S ─────────
 * Two different facts, from two different places, and conflating them is how
 * cost goes wrong in both directions.
 *
 * The RATE belongs to the quotation. A browser that submits one is submitting
 * a number nobody quoted, and it would be frozen into a version as evidence —
 * so it is ignored entirely and taken from the offer.
 *
 * The TREATMENT — whether the company gets that GST back — is a Finance
 * decision about this purchase, and the quotation cannot state it. It must be
 * said explicitly:
 *
 *   · `NON_TAXABLE` quotation → the supply carries no GST at all, so the
 *     treatment is `NONE` and the rate is a recorded 0. Nothing to recover and
 *     nothing to add.
 *   · taxable quotation → `RECOVERABLE` or `NON_RECOVERABLE`, stated. `NONE`
 *     is refused: it is not a third opinion about recoverability, it is the
 *     absence of one, and defaulting it either way is the silent assumption
 *     this refuses to make. Defaulting to recoverable under-costs every
 *     non-recoverable purchase; defaulting to non-recoverable over-costs the
 *     rest.
 *
 * A taxable quotation with no recorded rate cannot state a tax position at
 * all, so it is refused rather than treated as zero-rated.
 */
function taxPositionFor(offer, requestedTreatment) {
  const asked = String(requestedTreatment || "").toUpperCase();

  if (offer.priceBasis === "NON_TAXABLE") {
    if (asked && asked !== "NONE") {
      throw fail(CODES.TAX_TREATMENT_NOT_ALLOWED,
        "This quotation is non-taxable, so there is no GST to recover or absorb.",
        { offerId: offer.offerId, priceBasis: offer.priceBasis, requested: asked });
    }
    /* A stated nil, recorded as one. */
    return { treatment: "NONE", ratePercent: "0" };
  }

  if (asked !== "RECOVERABLE" && asked !== "NON_RECOVERABLE") {
    throw fail(CODES.TAX_TREATMENT_REQUIRED,
      "Say whether the GST on this quotation is recoverable. It changes the garment cost, and it cannot be guessed from the quotation.",
      {
        offerId: offer.offerId,
        priceBasis: offer.priceBasis,
        requested: asked || null,
        allowed: ["RECOVERABLE", "NON_RECOVERABLE"],
      });
  }
  if (!present(offer.gstRatePercent)) {
    throw fail(CODES.GST_NOT_RECORDED,
      "This quotation records no GST rate, so its tax cannot be applied to a costing. Ask the supplier for the rate, or record the supply as non-taxable.",
      { offerId: offer.offerId, priceBasis: offer.priceBasis });
  }
  return { treatment: asked, ratePercent: String(offer.gstRatePercent) };
}

/**
 * Can the purchase unit be turned into the consumption unit?
 *
 * ── ONLY THROUGH A DECLARED CONVERSION ──────────────────────────────────────
 * Same unit is trivially yes. A factor declared on the Unit master is yes, and
 * the factor is recorded in the provenance. Anything else is
 * "conversion not configured" and the line is refused — treating a metre as a
 * kilogram is not an approximation, it is a different number.
 */
function conversionFor({ purchaseUom, consumptionUom, unitFacts }) {
  const from = String(purchaseUom || "").trim();
  const to = String(consumptionUom || "").trim();
  if (!from || !to) {
    return { configured: false, reason: "UOM_NOT_RECORDED", from: from || null, to: to || null };
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    return { configured: true, sameUnit: true, factor: "1", from, to, path: `${from} → ${to} (same unit)` };
  }
  const hit = (unitFacts?.conversions || []).find(
    (c) => String(c.toUnitName || "").toLowerCase() === to.toLowerCase(),
  );
  if (hit && Number.isFinite(Number(hit.factor)) && Number(hit.factor) > 0) {
    return {
      configured: true, sameUnit: false, factor: String(hit.factor),
      from, to, path: `1 ${from} = ${hit.factor} ${to}`,
    };
  }
  return { configured: false, reason: "CONVERSION_NOT_CONFIGURED", from, to };
}

/**
 * Resolve one MATERIAL line's rate from the offer it names.
 *
 * Returns the rate the engine should use AND the provenance to freeze. Throws
 * a named refusal where the offer cannot honestly price the line.
 *
 * `scenarioQuantities` are the run sizes being costed — they decide the tier.
 */
async function resolveLineRate(ctx, {
  supplierOfferId, itemId, variantId = null, consumptionUom,
  category = "MATERIAL", behaviour = "PER_UNIT", quantityPerUnit, quantityPerRun,
  /* How many finished garments one shipping carton holds — from
     `sample.shipment`, the style's single statement of it, shared with
     freight. Only read on a PER_CARTON line. */
  garmentsPerCarton,
  evidence = null,
  scenarioQuantities = [], asOf = new Date(),
  costingCurrency, roundingMode = "HALF_UP",
  /* What the line SAYS about recoverability. The rate is never taken from the
     caller; only this is, and only from the two values that mean something. */
  taxTreatment = null,
} = {}) {
  /* Checked before the offer is even read: a line that could never be priced
     this way should say so about ITSELF, not about the quotation. */
  assertEligible({ category, behaviour, quantityPerUnit, quantityPerRun });

  const offer = await offerRead.currentOfferById(
    { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_line_pricing" },
    supplierOfferId, { asOf },
  );
  /* Draft, withdrawn, superseded, expired and future all answer null — the
     adapter makes that decision once so no caller can make a different one. */
  if (!offer) {
    throw fail(CODES.OFFER_NOT_USABLE,
      "That supplier quotation is not current for this costing date, so it cannot price a line.",
      { supplierOfferId, asOf });
  }

  /* ── THE OFFER MUST BE FOR THIS LINE'S SUBJECT ───────────────────────────
     An item-wide quotation prices any variant of that item; a variant-specific
     one prices only its own. Checked here rather than trusted from the form,
     because a stale screen would otherwise cost a poplin line at a twill
     quotation and freeze it as evidence. */
  if (String(offer.itemId) !== String(itemId)) {
    throw fail(CODES.OFFER_SUBJECT_MISMATCH,
      "That quotation is for a different item.",
      { expectedItemId: String(offer.itemId) });
  }
  if (offer.variantId && String(offer.variantId) !== String(variantId || "")) {
    throw fail(CODES.OFFER_SUBJECT_MISMATCH,
      "That quotation is for a different variant of this item.",
      { expectedVariantId: String(offer.variantId) });
  }

  /* ── AND THE SUPPLIER MUST STILL BE ONE WE BUY FROM ─────────────────────
     `currentOfferById` answers "is this quotation live?" — its lifecycle and
     its dates. It says nothing about the supplier, because the offer record
     does not know: a company can be deactivated long after it quoted, and the
     quotation goes on looking perfectly current.

     Store's `/applicable` listing already checked this, and this path did not
     — so a supplier the Store register showed as unavailable could still be
     picked and saved here, and frozen into a version as evidence of a price
     from a company nobody buys from any more.

     Re-read through the SAME company-scoped boundary Store uses, so "not
     ours" and "not there" stay one answer.

     Deliberately NOT wrapped in a catch: `supplierIdentity` returns null for
     absent-or-foreign and THROWS for an outage, and those are different
     facts. Catching would turn a database blip into "this supplier is
     inactive" — a refusal that reads as a settled commercial decision and
     sends somebody to re-negotiate a relationship that is perfectly fine. */
  const supplier = await storeFacts.supplierIdentity(
    { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_line_pricing" },
    offer.supplierId,
  );
  /* Same reading the Store listing applies, so the two cannot disagree:
     anything that is not `active` — inactive, pending, or a supplier this
     company cannot see — is not somebody to cost against today. */
  const supplierActive = supplier
    ? String(supplier.status || "active").toLowerCase() === "active"
    : false;
  if (!supplierActive) {
    throw fail(CODES.INACTIVE_SUPPLIER,
      `${offer.supplierName || "That supplier"} is not currently active, so their quotation cannot price a new costing.`,
      {
        supplierOfferId,
        supplierId: String(offer.supplierId),
        /* Absent and inactive are one answer to the caller; the detail says
           only what a person needs in order to act. */
        status: supplier ? supplier.status || null : null,
      });
  }

  /* ── NO SILENT CURRENCY EQUALITY ─────────────────────────────────────────
     There is no approved conversion contract in the costing policy, so an
     offer in another currency cannot be used. Treating USD 12.00 as ₹12.00 is
     not an approximation. */
  if (costingCurrency && String(offer.currency) !== String(costingCurrency)) {
    throw fail(CODES.CURRENCY_CONVERSION_REQUIRED,
      `This quotation is in ${offer.currency} and the costing is in ${costingCurrency}. No conversion rate is configured, so it cannot be used.`,
      { offerCurrency: offer.currency, costingCurrency });
  }

  /* ── THE CONVERSION COMES FIRST, BECAUSE THE TIER DEPENDS ON IT ─────────
     A tier is stated in the supplier's own purchase unit, so the quantity it
     is compared against has to be in that unit too — which cannot be worked
     out until the conversion is known. Checking the tier first was the bug:
     it compared garments against metres. */
  /* The item and variant as they read TODAY — snapshotted below, so the
     version stays readable after they are renamed. Best-effort: a costing
     must not fail because a display name could not be fetched. */
  const subject = await storeFacts.itemFacts(
    { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_line_pricing" },
    itemId, { variantId: variantId || null },
  ).then((item) => ({
    item,
    variant: variantId
      ? (item?.variants || []).find((v) => String(v.variantId) === String(variantId)) || null
      : null,
  })).catch(() => null);

  const unitFacts = await storeFacts.unitFacts(
    { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_line_pricing" },
    offer.purchaseUom,
  ).catch(() => null);
  const conversion = conversionFor({
    purchaseUom: offer.purchaseUom, consumptionUom, unitFacts,
  });
  if (!conversion.configured) {
    throw fail(CODES.CONVERSION_NOT_CONFIGURED,
      conversion.reason === "UOM_NOT_RECORDED"
        ? "The consumption unit is not recorded, so this quotation cannot be applied to the line."
        : `No conversion is configured from ${conversion.from} to ${conversion.to}, so this quotation cannot price the line.`,
      conversion);
  }

  /* ── HOW MUCH THE SUPPLIER IS ACTUALLY BEING ASKED FOR ───────────────────
     Per scenario, independently: two scenarios with the same output quantity
     but different consumption reach different supplier quantities, and
     sharing one would apply a tier neither of them earned. */
  /* ── ONE ENTRY PER SCENARIO, KEYED ─────────────────────────────────────
     A bare list of quantities was enough while every scenario shared one
     rate. Now that each may reach its own tier, the rate has to come back
     keyed to the scenario it belongs to — an index would silently mis-assign
     the moment scenarios were reordered. A plain number is still accepted so
     the picker, which has no scenario keys, keeps working. */
  const outputs = (scenarioQuantities || [])
    .map((s_, i) => (typeof s_ === "object" && s_ !== null
      ? { key: String(s_.key ?? `q${i}`), quantity: Number(s_.quantity) }
      : { key: `q${i}`, quantity: Number(s_) }))
    .filter((s_) => Number.isFinite(s_.quantity) && s_.quantity > 0);

  if (!outputs.length) {
    throw fail(CODES.SCENARIO_QUANTITY_REQUIRED,
      "A quotation-backed line needs a run size, so the supplier quantity — and therefore the tier — can be worked out.",
      { offerId: offer.offerId });
  }

  /* ── EVERY SCENARIO IS PRICED ON ITS OWN TERMS ─────────────────────────
     The quotation is re-read once and then applied to each scenario's OWN
     supplier quantity: its own MOQ check, its own order-multiple check, its
     own tier. Nothing is interpolated and no tier is borrowed from a
     neighbour — a rate that applies at 3,000 is not evidence about 500. */
  const perScenario = outputs.map(({ key, quantity: outputQuantity }) => {
    const purchaseQuantity = purchaseQuantityFor({
      outputQuantity, quantityPerUnit, quantityPerRun, behaviour,
      garmentsPerCarton,
      conversionFactor: conversion.factor,
    });
    const shown = purchaseQuantity ? purchaseQuantity.toFixed() : null;
    const verdict = checkQuantity(offer, shown === null ? "0" : shown);
    return {
      scenarioKey: key,
      outputQuantity: String(outputQuantity),
      purchaseQuantity: shown,
      verdict,
      ...(verdict.ok
        ? {
          covered: true,
          source: verdict.tier.source,
          minQuantity: verdict.tier.minQuantity,
          maxQuantity: verdict.tier.maxQuantity ?? null,
          unitPriceMinor: verdict.tier.unitPriceMinor,
        }
        : { covered: false, source: null, minQuantity: null, maxQuantity: null }),
    };
  });

  /* ── ONE UNSUPPORTED SCENARIO REFUSES THE WHOLE VERSION ────────────────
     Not the line, and not silently that scenario: a costing whose 3,000 case
     was quietly dropped would present a comparison with a missing arm and
     read as complete. The refusal names WHICH scenario, at what supplier
     quantity, and why — so the person knows whether to re-quote or to drop
     the quantity. */
  const blocked = perScenario.filter((p) => !p.verdict.ok);
  if (blocked.length) {
    const first = blocked[0].verdict;
    throw fail(
      QUANTITY_CODE[first.code] || CODES.OFFER_NOT_USABLE,
      first.message,
      {
        offerId: offer.offerId,
        purchaseUom: offer.purchaseUom,
        moq: offer.moq ?? null,
        orderMultiple: offer.orderMultiple ?? null,
        scenarios: blocked.map((p) => ({
          scenarioKey: p.scenarioKey,
          outputQuantity: p.outputQuantity,
          purchaseQuantity: p.purchaseQuantity,
          code: p.verdict.code,
          message: p.verdict.message,
        })),
      },
    );
  }

  /* ── THE TAX POSITION, FROM THE OFFER AND THE STATED TREATMENT ─────────
     Never from the browser, and the same for every scenario: recoverability
     is a property of the purchase, not of how many were bought. */
  const tax = taxPositionFor(offer, taxTreatment);

  /* ── THE RATE THE ENGINE USES, PER SCENARIO ────────────────────────────
     Per ONE consumption unit. `factor` is how many consumption units one
     purchase unit yields, so the rate per consumption unit is the net rate
     divided by it. Exact, and rounded once, for each scenario separately —
     rounding a shared figure and reusing it would put one scenario's paise
     into another's total. */
  const factor = new Decimal(conversion.factor);
  const priced = perScenario.map((p) => {
    const net = netRateMinor(offer, p.unitPriceMinor, roundingMode);
    return {
      ...p,
      netMinor: net.netMinor,
      netDerived: net.derived,
      gstAmountMinor: net.gstAmountMinor ?? null,
      grossMinor: net.grossMinor ?? null,
      rateMinor: roundMinor(new Decimal(net.netMinor).dividedBy(factor), roundingMode),
    };
  });

  /* The first scenario's rate remains `rateMinor` so a caller that knows
     nothing about scenarios — the picker — still gets one number. */
  const applied = priced[0];
  const rateMinor = applied.rateMinor;
  const { netMinor, netDerived: derived, gstAmountMinor, grossMinor } = applied;
  const gstRatePercent = offer.gstRatePercent;

  /* ── A FIXED LINE IS A TOTAL, NOT A RATE ───────────────────────────────
     The engine takes `amount` for a FIXED_PER_RUN line and `unitRate` for a
     per-piece one, so the total is worked out HERE — where the purchase
     quantity and the net rate are both in hand — rather than left to a caller
     to multiply and round on its own terms. Identical for every scenario,
     because the supplier is asked for the same quantity whatever the run: the
     dilution across that run is the engine's arithmetic, not this one's. */
  const fixedAmountMinor = behaviour === "FIXED_PER_RUN" && applied.purchaseQuantity !== null
    ? roundMinor(
      new Decimal(applied.rateMinor).multipliedBy(new Decimal(applied.purchaseQuantity)),
      roundingMode,
    )
    : null;

  /* ── A CARTON TOTAL IS A RUN TOTAL THAT STEPS ──────────────────────────
     Unlike a fixed line it is NOT the same money at every run size, and
     unlike a per-piece line it does not scale smoothly: 500 garments and 501
     buy twenty and twenty-one cartons. So each scenario gets its own total,
     computed from its own carton count and rounded once — the same
     `amountByScenario` shape the freight family already hands the engine for
     exactly this reason. */
  const amountsByScenario = behaviour === "PER_CARTON"
    ? Object.fromEntries(priced
      .filter((p) => p.purchaseQuantity !== null)
      .map((p) => [p.scenarioKey, {
        amountMinor: roundMinor(
          new Decimal(p.rateMinor).multipliedBy(new Decimal(p.purchaseQuantity)),
          roundingMode,
        ),
        currency: offer.currency,
      }]))
    : null;

  return {
    rateMinor,
    ...(fixedAmountMinor === null ? {} : { fixedAmountMinor }),
    /* Present only on a carton line. `versionCreation` puts it on the line as
       `amountByScenario`, which the engine already understands. */
    ...(amountsByScenario && Object.keys(amountsByScenario).length
      ? { amountsByScenario, fixedAmountMinor: amountsByScenario[applied.scenarioKey]?.amountMinor ?? null }
      : {}),
    currency: offer.currency,
    /* ── THE ENGINE'S PER-SCENARIO RATE TABLE (Chunk 5A) ─────────────────
       Keyed by scenario, so 500 pays the base quotation and 3,000 pays the
       tier it actually reaches. Server-derived from the quotation for each
       scenario's own supplier quantity; the parser refuses any client
       attempt to supply one. */
    ratesByScenario: Object.fromEntries(priced.map((p) => [
      p.scenarioKey, { amountMinor: p.rateMinor, currency: offer.currency },
    ])),
    /* The engine's own tax shape, server-derived. `versionCreation` puts this
       onto the line in place of whatever the request carried. */
    tax,
    /* ── WHAT GETS FROZEN ─────────────────────────────────────────────────
       Everything a reader needs a year later to say which quotation produced
       this rate, without the Store register having to still agree. */
    provenance: {
      state: "SUPPLIER_QUOTATION",
      offerId: offer.offerId,
      offerRevision: offer.revision,
      supplierId: offer.supplierId,
      supplierName: offer.supplierName,
      itemId: String(itemId),
      variantId: variantId ? String(variantId) : null,
      supplierItemCode: offer.supplierItemCode,
      supplierItemName: offer.supplierItemName,
      /* ── READABLE WITHOUT THE MASTERS ──────────────────────────────────
         Ids alone are not evidence: an item renamed, a variant recoded or a
         supplier merged leaves a frozen version pointing at records that no
         longer read the same way. The names are snapshotted so a costing from
         March still says what it costed, whatever happened since.

         Plain values, never a document handle — a Mongoose object frozen
         into a version would be a live reference wearing a snapshot's name. */
      itemName: subject?.item?.name || null,
      itemSku: subject?.item?.sku || null,
      variantLabel: subject?.variant
        ? ((subject.variant.combination || []).join(" / ") || subject.variant.sku || null)
        : null,
      variantSku: subject?.variant?.sku || null,
      /* Omitted when there is none — a nested path set to null is not an
         absence, it is a shape the schema has to accept for no reason. */
      ...(offer.document
        ? { document: { label: offer.document.label || "", url: offer.document.url || "", storedAt: offer.document.storedAt || "" } }
        : {}),
      /* Frozen with the rate: a costing has to be able to say whether the
         figure it used already contained delivery to our warehouse. */
      freightTerms: offer.freightTerms || null,
      incoterm: offer.incoterm || null,
      /* ── WHICH RULE PICKED THIS QUOTATION ────────────────────────────
         `VARIANT_SPECIFIC_PREFERRED` means a whole-item rate also applied
         and was superseded by one naming this exact variant. `WHOLE_ITEM`
         means the quotation covers the item and no variant-specific one
         existed. Frozen, because "why this rate and not the other" is
         exactly the question asked six months later, and re-deriving it
         needs a register that has since moved. */
      selectionRule: offer.selectionRule || null,
      variantSpecific: offer.variantSpecific === true,
      quotationReference: offer.quotationReference,
      /* The date on the supplier's own paper, distinct from when the price
         took effect and from when somebody entered it. */
      quotationDate: offer.quotationDate || null,
      asOf,
      currency: offer.currency,
      /* The quoted figure as it stands on the quotation. */
      quotedAmountMinor: applied.unitPriceMinor,
      priceBasis: offer.priceBasis,
      /* ── THE OFFER IS THE TAX SOURCE, AND SAYS SO ────────────────────
         The RawItem master carries no HSN or GST at all. Snapshotting the
         quotation's own figures keeps that visible rather than implying the
         item master supplied them. */
      hsnCode: offer.hsnCode || null,
      gstRatePercent: present(offer.gstRatePercent) ? offer.gstRatePercent : null,
      /* A NON_TAXABLE quotation HAS a recorded tax position — a stated nil.
         An unrecorded rate does not, and the two must not read alike. */
      gstRecorded: present(offer.gstRatePercent) || offer.priceBasis === "NON_TAXABLE",
      /* ── WHICH TREATMENT WAS APPLIED, FROZEN ─────────────────────────
         The rate alone does not say whether the company got that GST back,
         and that is the difference between the tax being cost and not being
         cost. A version that recorded only the rate could not be re-read. */
      gstTreatment: tax.treatment,
      /* The split, frozen rather than left to be re-derived later from a rate
         and a rounding rule that may both have moved on since. */
      gstAmountMinor: gstAmountMinor === undefined ? null : gstAmountMinor,
      grossRateMinor: grossMinor === undefined ? null : grossMinor,
      /* Which rule produced the rounded figures above. */
      roundingMode,
      netRateMinor: netMinor,
      netRateDerived: derived,
      purchaseUom: offer.purchaseUom,
      consumptionUom,
      conversionFactor: conversion.factor,
      conversionPath: conversion.path,
      priceSource: applied.source,
      tierMinQuantity: applied.minQuantity,
      tierMaxQuantity: applied.maxQuantity ?? null,
      /* ── THE QUANTITY THE TIER WAS JUDGED ON ────────────────────────────
         Frozen, because "why did this line get the 1,000-unit price" is
         unanswerable a year later without it — the finished-goods quantity
         alone does not explain it. */
      /* Whichever field the behaviour actually reads — a fixed line has no
         per-piece consumption, and freezing a zero for it would read as one. */
      behaviour,
      /* Measured on the sample, or planned for production — frozen, because
         it is what says whether this line may read as verified. */
      ...(evidence ? { evidence } : {}),
      ...(behaviour === "FIXED_PER_RUN"
        ? { quantityPerRun: String(quantityPerRun), fixedAmountMinor }
        : { quantityPerUnit: String(quantityPerUnit) }),
      scenarioQuantities: priced.map((p) => ({
        outputQuantity: p.outputQuantity,
        purchaseQuantity: p.purchaseQuantity,
      })),
      /* ── EACH SCENARIO'S OWN COMMERCIAL FACTS, FROZEN ────────────────
         The base line above records what the LINE is; this records what each
         quantity actually reached. Without it a version could not answer
         "why was 3,000 cheaper" a year later without the quotation still
         being active — which is exactly what a frozen version must not
         depend on. */
      scenarios: priced.map((p) => ({
        scenarioKey: p.scenarioKey,
        outputQuantity: p.outputQuantity,
        purchaseQuantity: p.purchaseQuantity,
        purchaseUom: offer.purchaseUom,
        priceSource: p.source,
        tierMinQuantity: p.minQuantity,
        tierMaxQuantity: p.maxQuantity,
        quotedAmountMinor: p.unitPriceMinor,
        netRateMinor: p.netMinor,
        netRateDerived: p.netDerived,
        gstAmountMinor: p.gstAmountMinor,
        grossRateMinor: p.grossMinor,
        /* Per ONE consumption unit — the number the engine multiplies. */
        effectiveRateMinor: p.rateMinor,
        conversionFactor: conversion.factor,
        taxTreatment: tax.treatment,
      })),
      appliedPurchaseQuantity: applied.purchaseQuantity,
      moq: offer.moq,
      orderMultiple: offer.orderMultiple,
      leadTimeDays: offer.leadTimeDays,
      effectiveFrom: offer.effectiveFrom,
      validUntil: offer.validUntil,
      ...(present(gstRatePercent) ? {} : {}),
    },
    /* MOQ and order-multiple used to arrive here as notes. They are refusals
       now, so a quotation-backed line either priced or did not — there is no
       third state where it priced with a caveat about a quantity nobody can
       order. */
    warnings: [],
  };
}

/* `buildWarnings` used to live here. It turned a below-minimum or
   off-multiple quantity into a note and let the line price anyway — the
   inconsistency this pass exists to remove. Those cases are refusals in
   `resolveLineRate` now, decided by the one shared rule, so there is nothing
   left for it to build. */

module.exports = {
  CODES, netRateMinor, conversionFor, resolveLineRate,
  assertEligible, purchaseQuantityFor, taxPositionFor,
  /* Re-exported, not reimplemented — a caller reaching for a tier lookup here
     gets the same one the Store uses. */
  checkQuantity, tierFor,
};
