"use strict";
/**
 * services/storePurchase/offerApplicability.js
 *
 * Store & Purchase — WHICH QUOTATIONS COULD PRICE THIS QUANTITY, AND WHY THE
 * REST COULD NOT.
 *
 * ── WHY A PURE MODULE ───────────────────────────────────────────────────────
 * The decision was previously spread across three places: the read adapter
 * filtered by status and date in a Mongo query, the costing resolver threw on
 * unit and subject problems, and MOQ and order-multiple came back as warnings
 * from a fourth. Three different layers, three different vocabularies, and the
 * offers eliminated by the query were simply never mentioned again — so a
 * buyer looking for the supplier they had just entered was told "no
 * quotations", which is not what had happened.
 *
 * This module makes the whole decision in one pass over facts it is handed. It
 * opens no database connection and reads no clock, so the awkward cases —
 * an offer that expired yesterday, a tier gap, a unit with no conversion —
 * are testable directly rather than through a route.
 *
 * ── AN EXCLUSION IS AN ANSWER, NOT AN ABSENCE ───────────────────────────────
 * Every offer that came in comes back out: in `applicable`, or in `excluded`
 * with a code and a sentence. "No quotations" and "three quotations, one
 * expired last week, one below its minimum and one quoted in metres you have
 * no conversion for" are different answers, and only the second is useful.
 *
 * ── AND NOTHING IS CHOSEN HERE ──────────────────────────────────────────────
 * `lowestApplicableOfferId` is INFORMATION. This module does not pick a
 * supplier, does not rank by price and does not sort cheapest-first — a
 * costing that silently took the lowest rate would be making a sourcing
 * decision nobody approved, in a screen nobody was looking at. The order is
 * stable and deliberately not price-based; a person chooses.
 */

const BigNumber = require("bignumber.js");

/* ── EVERY REASON AN OFFER CAN BE UNUSABLE ───────────────────────────────────
 * Named, because "not applicable" tells the buyer to go and guess. Each of
 * these has a different fix and a different person who fixes it. */
const EXCLUSIONS = Object.freeze({
  WRONG_COMPANY: "WRONG_COMPANY",
  WRONG_ITEM: "WRONG_ITEM",
  WRONG_VARIANT: "WRONG_VARIANT",
  /* ── A WHOLE-ITEM RATE BEATEN BY A SPECIFIC ONE ────────────────────────
     Not a fault: the quotation is perfectly valid and would price this line
     if nothing more specific existed. It is excluded because something more
     specific does, and saying so is the difference between "your quotation
     is wrong" and "we used the one for this colour". */
  SUPERSEDED_BY_VARIANT: "SUPERSEDED_BY_VARIANT",
  NOT_PUBLISHED: "NOT_PUBLISHED",
  WITHDRAWN: "WITHDRAWN",
  SUPERSEDED: "SUPERSEDED",
  NOT_YET_EFFECTIVE: "NOT_YET_EFFECTIVE",
  EXPIRED: "EXPIRED",
  INACTIVE_SUPPLIER: "INACTIVE_SUPPLIER",
  INACTIVE_ITEM: "INACTIVE_ITEM",
  INCOMPATIBLE_UOM: "INCOMPATIBLE_UOM",
  BELOW_MOQ: "BELOW_MOQ",
  NOT_AN_ORDER_MULTIPLE: "NOT_AN_ORDER_MULTIPLE",
  NO_QUANTITY_TIER: "NO_QUANTITY_TIER",
  QUANTITY_NOT_STATED: "QUANTITY_NOT_STATED",
});

const present = (v) => v !== null && v !== undefined && v !== "";
const id = (v) => (present(v) ? String(v) : null);
const fmt = (n) => {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString("en-IN") : String(n);
};

/**
 * The tier covering `quantity`, in the offer's own purchase unit.
 *
 * ── A GAP IS NOT A PRICE ────────────────────────────────────────────────────
 * Where the supplier quoted tiers and none of them covers the quantity, the
 * answer is nothing — not the base price, not the nearest band. A supplier
 * whose bands run 500–999 has said nothing about 5,000, and handing back a
 * rate there would freeze a number nobody offered into a costing version as
 * evidence.
 *
 * Where no tiers were quoted at all, the offer's own price applies at every
 * quantity, which is what a single-price quotation means.
 */
function tierFor(offer, quantity) {
  const tiers = Array.isArray(offer?.tiers) ? offer.tiers : [];
  const q = new BigNumber(String(quantity));
  if (!tiers.length) {
    return { covered: true, source: "BASE", unitPriceMinor: offer.unitPriceMinor, minQuantity: null, maxQuantity: null };
  }
  if (!q.isFinite()) return { covered: false };
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    const min = new BigNumber(String(t.minQuantity));
    /* An explicit ceiling where the supplier stated one; otherwise the band
       runs until the next band starts, which is the established reading of a
       tier list and the one the register was built on. */
    const stated = present(t.maxQuantity) ? new BigNumber(String(t.maxQuantity)) : null;
    const next = tiers[i + 1] ? new BigNumber(String(tiers[i + 1].minQuantity)) : null;
    const covers = q.isGreaterThanOrEqualTo(min)
      && (stated !== null
        ? q.isLessThanOrEqualTo(stated)
        : (next === null || q.isLessThan(next)));
    if (covers) {
      return {
        covered: true, source: "TIER", unitPriceMinor: t.unitPriceMinor,
        minQuantity: Number(t.minQuantity),
        maxQuantity: present(t.maxQuantity) ? Number(t.maxQuantity) : null,
        note: t.note || null,
      };
    }
  }
  /* Below the first band the offer's own price applies — the supplier stated
     it, and a volume discount above it does not withdraw it. Past a stated
     ceiling, or inside a gap between two, nothing was quoted. */
  if (q.isLessThan(new BigNumber(String(tiers[0].minQuantity)))) {
    return { covered: true, source: "BASE", unitPriceMinor: offer.unitPriceMinor, minQuantity: null, maxQuantity: null };
  }
  return { covered: false };
}

/** Is `quantity` a whole number of `multiple`s? Exact — not a float remainder. */
function isOrderMultiple(quantity, multiple) {
  const q = new BigNumber(String(quantity));
  const m = new BigNumber(String(multiple));
  if (!q.isFinite() || !m.isFinite() || m.isLessThanOrEqualTo(0)) return true;
  return q.dividedBy(m).isInteger();
}

/**
 * THE ONE QUANTITY RULE. Does this offer cover this purchase quantity?
 *
 * ── WHY IT LIVES HERE AND NOTHING ELSE DECIDES IT ───────────────────────────
 * MOQ, order multiple and tier coverage were being judged in two places — the
 * Store's applicability listing excluded an offer below its minimum, and the
 * costing resolver attached a warning and priced the line anyway. So the
 * picker showed a supplier as unusable and the save accepted it, or the other
 * way round, depending on which screen you were on. Two implementations of one
 * commercial rule always drift; the only fix is that there is one.
 *
 * `quantity` is ALWAYS in the offer's own purchase UoM. Converting first is
 * the caller's job, because only the caller knows what unit its number is in.
 *
 * Returns `{ok: true, tier}` or `{ok: false, code, message, details}`.
 */
function checkQuantity(offer, quantity) {
  const uom = offer.purchaseUom || "units";
  const q = new BigNumber(String(quantity));
  if (!q.isFinite() || q.isLessThanOrEqualTo(0)) {
    return {
      ok: false,
      code: EXCLUSIONS.QUANTITY_NOT_STATED,
      message: "Say how much is needed before a quotation can be checked against its minimum and tiers.",
      details: {},
    };
  }
  const shown = q.toFixed();

  if (present(offer.moq) && q.isLessThan(new BigNumber(String(offer.moq)))) {
    return {
      ok: false,
      code: EXCLUSIONS.BELOW_MOQ,
      message: `This needs ${fmt(shown)} ${uom}; the supplier's minimum order is ${fmt(offer.moq)} ${uom}.`,
      details: { purchaseQuantity: shown, moq: offer.moq, purchaseUom: uom },
    };
  }
  if (present(offer.orderMultiple) && !isOrderMultiple(q, offer.orderMultiple)) {
    return {
      ok: false,
      code: EXCLUSIONS.NOT_AN_ORDER_MULTIPLE,
      message: `${fmt(shown)} ${uom} is not a multiple of ${fmt(offer.orderMultiple)} ${uom}.`,
      details: { purchaseQuantity: shown, orderMultiple: offer.orderMultiple, purchaseUom: uom },
    };
  }

  const tier = tierFor(offer, shown);
  if (!tier.covered) {
    return {
      ok: false,
      code: EXCLUSIONS.NO_QUANTITY_TIER,
      message: `The supplier quoted quantity bands, and none of them covers ${fmt(shown)} ${uom}. Ask for a rate at this quantity.`,
      details: {
        purchaseQuantity: shown,
        purchaseUom: uom,
        tiers: (offer.tiers || []).map((t) => ({
          minQuantity: t.minQuantity,
          maxQuantity: present(t.maxQuantity) ? t.maxQuantity : null,
        })),
      },
    };
  }
  return { ok: true, tier, purchaseQuantity: shown };
}

/**
 * Decide one offer.
 *
 * ── THE ORDER OF THE CHECKS IS THE POINT ────────────────────────────────────
 * Each returns the FIRST decisive reason, cheapest and most fundamental
 * first: whose record it is, what it is for, whether it is published, whether
 * the clock allows it, whether the masters behind it are still alive, and only
 * then the quantity arithmetic — which is the only part that needs a unit
 * conversion, and the only part that can be right for one run size and wrong
 * for another. Reporting "below minimum order" for a withdrawn quotation
 * would send somebody to renegotiate a price that no longer exists.
 */
function evaluate(offer, criteria, facts) {
  const out = {
    offerId: id(offer._id ?? offer.offerId),
    supplierId: id(offer.supplierId),
    supplierName: offer.supplierName || "",
    quotationReference: offer.quotationReference || null,
    revision: offer.revision ?? 1,
    purchaseUom: offer.purchaseUom || null,
    currency: offer.currency || null,
    /* Whether this quotation names one variant or the item as a whole. The
       precedence rule below reads it; nothing infers it from a label. */
    variantSpecific: present(offer.variantId),
    /* ── WHETHER THE RATE INCLUDED GETTING IT HERE ────────────────────
       Carried through the summary because the costing has to be able to ask
       it of the quotation a line actually got. Absent is an unanswered
       question, not a landed rate. */
    freightTerms: offer.freightTerms || null,
    incoterm: offer.incoterm || null,
    /* ── AND WHERE THE GOODS CAME FROM ────────────────────────────────
       Carried for the same reason as the freight terms: customs duty is a
       question about the quotation a line actually got, and re-reading the
       offer to answer it would be a second read that could disagree with the
       first. Identity and classification only — never the rate. */
    sourcing: {
      type: offer.sourcing?.type || null,
      countryOfOrigin: offer.sourcing?.countryOfOrigin || null,
      dutyInQuotedRate: offer.sourcing?.dutyInQuotedRate || null,
    },
    revision: offer.revision ?? null,
  };
  const no = (code, message, extra = {}) => ({ ...out, applicable: false, code, message, ...extra });

  if (id(offer.companyId) && id(criteria.companyId) && id(offer.companyId) !== id(criteria.companyId)) {
    /* Belt and braces behind a scoped query. If this ever fires, the caller
       handed us another company's row and the resolver is the last thing
       between it and a costing. */
    return no(EXCLUSIONS.WRONG_COMPANY, "That quotation belongs to another company.");
  }
  if (id(criteria.itemId) && id(offer.itemId) !== id(criteria.itemId)) {
    return no(EXCLUSIONS.WRONG_ITEM, "This quotation is for a different item.");
  }
  /* An item-wide quotation prices any variant; a variant-specific one prices
     only its own. Absent on the offer means "the item", not "unknown". */
  if (present(offer.variantId) && id(offer.variantId) !== id(criteria.variantId)) {
    return no(EXCLUSIONS.WRONG_VARIANT, "This quotation is for a different variant of this item.");
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

  /* ── THE CLOCK IS A PARAMETER ────────────────────────────────────────────
     A costing dated in June must resolve the quotation that was in force in
     June, so "expired" is judged against the costing date and never against
     whenever this happens to run. */
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

  /* ── THE MASTERS BEHIND IT MUST STILL BE ALIVE ───────────────────────────
     A live quotation from a supplier somebody deactivated is not a price you
     may cost against — and the offer record itself has no way to know, which
     is why these arrive as facts. `null` means the caller did not look, and
     an unchecked fact is never treated as a pass. */
  if (facts.supplierActive && facts.supplierActive(id(offer.supplierId)) === false) {
    return no(EXCLUSIONS.INACTIVE_SUPPLIER,
      `${offer.supplierName || "That supplier"} is no longer active.`);
  }
  if (facts.itemActive === false) {
    return no(EXCLUSIONS.INACTIVE_ITEM, "That item is no longer active.");
  }

  /* ── THE QUANTITY, IN THE SUPPLIER'S OWN UNIT ────────────────────────────
     Every quantity term on a quotation — MOQ, order multiple, every tier — is
     stated in the purchase UoM. Comparing a requirement in metres against a
     minimum in rolls is the bug that made a 1,000-roll minimum look satisfied
     by 1,000 metres, so the conversion happens first and everything below is
     judged on the converted number. */
  const conversion = facts.conversionFor
    ? facts.conversionFor({ from: offer.purchaseUom, to: criteria.requestedUom })
    : { configured: String(offer.purchaseUom || "").toLowerCase() === String(criteria.requestedUom || "").toLowerCase(), factor: "1" };

  if (!conversion.configured) {
    return no(EXCLUSIONS.INCOMPATIBLE_UOM,
      conversion.reason === "UOM_NOT_RECORDED"
        ? "The unit this line is measured in is not recorded, so a quotation cannot be applied to it."
        : `This quotation is per ${offer.purchaseUom}, and no conversion to ${criteria.requestedUom} is configured.`,
      { conversion });
  }

  if (!present(criteria.quantity)) {
    return no(EXCLUSIONS.QUANTITY_NOT_STATED,
      "Say how much is needed before a quotation can be checked against its minimum and tiers.");
  }
  const factor = new BigNumber(String(conversion.factor ?? "1"));
  const requested = new BigNumber(String(criteria.quantity));
  if (!requested.isFinite() || requested.isLessThanOrEqualTo(0) || !factor.isFinite() || factor.isLessThanOrEqualTo(0)) {
    return no(EXCLUSIONS.QUANTITY_NOT_STATED,
      "Say how much is needed before a quotation can be checked against its minimum and tiers.");
  }
  /* `factor` is how many REQUESTED units one PURCHASE unit yields. */
  const purchaseQuantity = requested.dividedBy(factor);
  const shown = purchaseQuantity.toFixed();
  const uom = offer.purchaseUom || "units";

  /* ── ONE RULE, NOT A SECOND COPY OF IT ──────────────────────────────────
     MOQ, order multiple and tier coverage are decided by `checkQuantity`,
     which the costing resolver also calls — so the listing, the picker and
     the save cannot reach different verdicts about the same quantity. */
  const verdict = checkQuantity(offer, purchaseQuantity.toFixed());
  if (!verdict.ok) return no(verdict.code, verdict.message, verdict.details);
  const tier = verdict.tier;

  return {
    ...out,
    applicable: true,
    code: null,
    message: null,
    purchaseQuantity: shown,
    conversion,
    /* The quoted figure for THIS quantity, on the quotation's own basis. The
       net-of-tax rate is worked out from the basis by the caller that needs
       it — this module reports what was quoted. */
    appliedUnitPriceMinor: tier.unitPriceMinor,
    priceSource: tier.source,
    tierMinQuantity: tier.minQuantity,
    tierMaxQuantity: tier.maxQuantity,
    tierNote: tier.note || null,
    priceBasis: offer.priceBasis || null,
    gstRatePercent: present(offer.gstRatePercent) ? offer.gstRatePercent : null,
    hsnCode: offer.hsnCode || null,
    moq: present(offer.moq) ? offer.moq : null,
    orderMultiple: present(offer.orderMultiple) ? offer.orderMultiple : null,
    leadTimeDays: present(offer.leadTimeDays) ? offer.leadTimeDays : null,
    effectiveFrom: offer.effectiveFrom || null,
    validUntil: offer.validUntil || null,
  };
}

/**
 * Split a list of quotations into the ones that can price this quantity and
 * the ones that cannot, each with its reason.
 *
 * `facts` supplies what the offer records cannot know about themselves:
 *   • `supplierActive(supplierId)` → true / false / null (not checked)
 *   • `itemActive`                 → true / false / null
 *   • `conversionFor({from, to})`  → {configured, factor, path, reason}
 *
 * Order is by supplier name, then quotation reference, then id — stable across
 * calls and deliberately NOT by price. A cheapest-first list is a
 * recommendation, and this module does not make one.
 */
function resolveApplicableOffers({ offers = [], criteria = {}, facts = {} } = {}) {
  const evaluated = offers.map((o) => evaluate(o, criteria, facts));
  let applicable = evaluated.filter((e) => e.applicable);
  const excluded = evaluated.filter((e) => !e.applicable);

  /* ── THE SPECIFIC RATE WINS OVER THE GENERAL ONE ────────────────────────
     A quotation naming this exact variant and one naming the item as a whole
     can both apply to the same line on the same date at the same quantity.
     Reporting them as a tie asks a buyer to choose between "the rate for
     black" and "the rate for this fabric" — a question with an obvious
     answer that the system should not be making a person give.

     So a variant-specific quotation supersedes a whole-item one, and the
     whole-item one is EXCLUDED with a reason rather than dropped, because a
     buyer looking at the lane deserves to see it was considered. Two
     variant-specific quotations remain a genuine decision, and so do two
     whole-item ones: this rule breaks one tie and invents no others.

     The rule that selected the offer travels on it, so a costing's
     provenance can say which one applied rather than leaving a reader to
     re-derive it. */
  const variantSpecific = applicable.filter((a) => a.variantSpecific);
  if (variantSpecific.length && variantSpecific.length < applicable.length) {
    for (const a of applicable) {
      if (a.variantSpecific) continue;
      excluded.push({
        ...a,
        applicable: false,
        code: EXCLUSIONS.SUPERSEDED_BY_VARIANT,
        message: "A quotation for this exact variant applies, so the whole-item rate was not used.",
        selectionRule: "WHOLE_ITEM_SUPERSEDED",
      });
    }
    applicable = variantSpecific;
  }
  for (const a of applicable) {
    a.selectionRule = a.variantSpecific
      ? (variantSpecific.length < evaluated.filter((e) => e.applicable).length
        ? "VARIANT_SPECIFIC_PREFERRED" : "VARIANT_SPECIFIC")
      : "WHOLE_ITEM";
  }

  const byName = (a, b) =>
    String(a.supplierName || "").localeCompare(String(b.supplierName || ""))
    || String(a.quotationReference || "").localeCompare(String(b.quotationReference || ""))
    || String(a.offerId || "").localeCompare(String(b.offerId || ""));
  applicable.sort(byName);
  excluded.sort(byName);

  /* ── INFORMATION, NOT A DECISION ─────────────────────────────────────────
     Reported so a buyer can see it at a glance; never applied. Comparing
     across currencies would be meaningless, so a mixed-currency list reports
     no lowest at all rather than a wrong one. */
  const currencies = new Set(applicable.map((a) => a.currency));
  const lowest = currencies.size === 1
    ? applicable.reduce((best, a) =>
      (best === null || a.appliedUnitPriceMinor < best.appliedUnitPriceMinor ? a : best), null)
    : null;

  return {
    applicable,
    excluded,
    lowestApplicableOfferId: lowest ? lowest.offerId : null,
    lowestApplicableRateMinor: lowest ? lowest.appliedUnitPriceMinor : null,
  };
}

module.exports = {
  EXCLUSIONS, resolveApplicableOffers, evaluate, checkQuantity, tierFor, isOrderMultiple,
};
