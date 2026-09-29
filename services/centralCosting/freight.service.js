"use strict";
/**
 * services/centralCosting/freight.service.js
 *
 * WHAT IT COSTS TO DELIVER THE FINISHED ORDER — AND WHO PAYS IT.
 *
 * ── THE DISTINCTION THIS FILE KEEPS ─────────────────────────────────────────
 * Freight paid to bring fabric INTO our warehouse is part of what the fabric
 * cost, and belongs in the material's rate. Freight paid to take garments OUT
 * to the customer is a cost of the order. They are different money, owed to
 * different people, at different times, and adding one to the other either
 * double-counts the inbound leg or invents an outbound one.
 *
 * Only the outbound leg is priced here. Nothing in this file reads
 * `PurchaseOrder.shippingCharges` or `LandedCostAllocation`: both are records
 * of what was ACTUALLY paid on a real receipt, and one historical PO's charge
 * is not a forecast for an unrelated enquiry.
 *
 * ── A RECORDED ZERO IS NOT A MISSING COST ───────────────────────────────────
 * An ex-works order costs the company nothing to deliver, because the customer
 * collects it. That is an ANSWER — with an arrangement, a source and a person
 * behind it — and it is frozen as one. A costing with no freight line because
 * nobody asked is a different state entirely, and the completeness model has
 * to be able to tell them apart.
 *
 * ── AND NOTHING IS CALCULATED THAT CANNOT BE SOURCED ────────────────────────
 * Per kilogram needs a packed weight. Per carton needs a carton capacity. Both
 * are facts R&D measures on the sample, and where one is absent the costing
 * blocks and names R&D — it does not assume a garment weighs nothing, or that
 * one carton holds the whole order. Distance, dimensional weight, vehicles and
 * pallets have no factual input anywhere in this system and are not attempted.
 */

const { Decimal, roundMinor } = require("./decimal");
const { fail } = require("../storePurchase/errors");
const offerPricing = require("./offerPricing.service");

/** Who bears the freight, in the vocabulary `constants/crm.js` already uses. */
const ARRANGEMENTS = Object.freeze(["prepaid", "to_pay", "ex_works", "delivered"]);

/**
 * What each arrangement means for the COMPANY's cost.
 *
 * `ex_works` and `to_pay` are recorded zeros: the customer collects, or pays
 * the carrier directly. `delivered` is borne by the company and priced.
 *
 * `prepaid` is the one the codebase cannot answer. Its label is "Prepaid (we
 * pay)" while `delivered` is "Delivered (included in price)" — so the company
 * pays the carrier, and nothing anywhere says whether it recovers that from
 * the customer. Those two readings differ by the entire freight amount in the
 * garment cost, so it is a decision, asked of the desk that makes it.
 */
const TREATMENT = Object.freeze({
  ex_works: "RECORDED_ZERO",
  to_pay: "RECORDED_ZERO",
  delivered: "COMPANY_BEARS",
  prepaid: "DECISION_REQUIRED",
});

/**
 * And once the prepaid question IS answered, the two answers are two
 * different accounting outcomes — which is the whole reason it is asked.
 *
 * `IN_PRICE` is the company absorbing the freight into what it sells the
 * garment for: an ordinary cost, priced with everything else.
 *
 * `RECOVERED_SEPARATELY` is the company paying the carrier and billing the
 * customer for it. The money still leaves — it is NOT a zero company cost —
 * but it is not part of what the garment is worth either. Marking it up would
 * charge the customer a margin on their own reimbursement; folding it into the
 * unit price would bill them for it twice. So it is costed, frozen and carried
 * out to the quotation as its own approved figure, at cost.
 */
const PREPAID_TREATMENT = Object.freeze({
  IN_PRICE: "COMPANY_BEARS",
  RECOVERED_SEPARATELY: "RECOVERED_SEPARATELY",
});

const OWNER = Object.freeze({
  SALES: { department: "Sales", system: "Enquiry delivery terms" },
  RND: { department: "R&D", system: "SampleStyle shipment facts" },
  STORE_ADMIN: { department: "Store administration", system: "Warehouse master" },
  STORE_PURCHASE: { department: "Store / Purchase", system: "Freight quotation register" },
});

const CODES = Object.freeze({
  ARRANGEMENT_MISSING: "FREIGHT_ARRANGEMENT_MISSING",
  PREPAID_UNDECIDED: "FREIGHT_PREPAID_TREATMENT_REQUIRED",
  DESTINATION_MISSING: "FREIGHT_DESTINATION_MISSING",
  ORIGIN_MISSING: "FREIGHT_ORIGIN_MISSING",
  WEIGHT_MISSING: "FREIGHT_PACKED_WEIGHT_MISSING",
  CARTON_MISSING: "FREIGHT_CARTON_CAPACITY_MISSING",
  NO_OFFER: "FREIGHT_NO_APPLICABLE_QUOTATION",
  SEVERAL_OFFERS: "FREIGHT_QUOTATION_DECISION_REQUIRED",
  MULTI_DELIVERY: "FREIGHT_MULTI_DELIVERY_DECISION_REQUIRED",
});

const present = (v) => v !== null && v !== undefined && v !== "";
const id = (v) => (v ? String(v) : "");

/**
 * The arrangement that actually applies, and where it came from.
 *
 * ── THE ENQUIRY OUTRANKS THE ACCOUNT, AND THE DIFFERENCE IS FROZEN ──────────
 * The account's `freightArrangement` is a standing term. A customer who
 * normally collects may ask for ONE order delivered, and costing that order
 * at the standing term puts freight on a garment nobody is shipping — or
 * leaves it off one we are. So the enquiry answers for itself where it has an
 * answer, and the source is recorded, because "this customer's usual term" and
 * "what was agreed for this order" are different claims.
 */
function resolveArrangement({ enquiryFreight = null, accountFreight = null } = {}) {
  const asked = String(enquiryFreight?.arrangement || "");
  if (ARRANGEMENTS.includes(asked)) {
    return { arrangement: asked, source: "ENQUIRY", sourceLabel: "Agreed on this enquiry" };
  }
  const standing = String(accountFreight || "");
  if (ARRANGEMENTS.includes(standing)) {
    return { arrangement: standing, source: "ACCOUNT", sourceLabel: "The customer's standing term" };
  }
  return { arrangement: null, source: null, sourceLabel: null };
}

/**
 * Does this quotation cover this lane?
 *
 * Origin must match exactly — it is a warehouse this company owns. Destination
 * matches either the exact shipping address or a ZONE the address falls
 * inside, because a transporter quoting "anywhere in Karnataka" is quoting a
 * zone and forcing that into one address would need a quotation per customer.
 *
 * Zone matching is on the address's OWN recorded city, region and country. It
 * is never on distance: nothing here holds a distance between two places, and
 * inventing one would be inventing the rate that follows from it.
 */
function coversLane(offer, { originWarehouseId, destination, mode }) {
  if (id(offer.originWarehouseId) !== id(originWarehouseId)) return false;
  if (offer.mode !== mode) return false;

  if (present(offer.destinationAddressId)) {
    return id(offer.destinationAddressId) === id(destination?.addressId);
  }
  const zone = offer.destinationZone || {};
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  /* Every stated part of the zone has to match. A zone naming only a country
     covers the country; one naming a city covers that city. An EMPTY zone
     covers nothing — a quotation that names no destination at all is not a
     quotation for everywhere. */
  const parts = ["city", "region", "country"].filter((k) => present(zone[k]));
  if (!parts.length) return false;
  return parts.every((k) => same(zone[k], destination?.[k]));
}

/**
 * How much freight, for one scenario, from facts that actually exist.
 *
 * ── EVERY BASIS NEEDS SOMETHING, AND SAYS WHICH ─────────────────────────────
 * `PER_KG` multiplies the scenario's garment count by the packed weight and
 * converts grams to kilograms explicitly. `PER_CARTON` divides by the carton
 * capacity and rounds UP — the seventh carton is charged in full even when it
 * holds ten garments. `FIXED_PER_CONSIGNMENT` needs neither, and is the one
 * that dilutes.
 *
 * A blank fact is never read as one. "One carton" and "one kilogram" are
 * numbers somebody would have had to record, and a costing built on a
 * substituted 1 is wrong in a way nobody can see.
 */
function shipmentWorking(offer, { quantity, shipment = {}, roundingMode = "HALF_UP" }) {
  const q = new Decimal(String(quantity));

  if (offer.basis === "FIXED_PER_CONSIGNMENT") {
    return { chargeableExact: new Decimal(1), unit: "consignment", working: { consignments: "1" } };
  }

  if (offer.basis === "PER_KG") {
    if (!present(shipment.packedWeightGrams)) {
      return { missing: { code: CODES.WEIGHT_MISSING, owner: OWNER.RND } };
    }
    /* Grams on the record, kilograms on the quotation — converted here,
       explicitly, because the field name says grams and the rate says kg. */
    const kg = q.multipliedBy(new Decimal(String(shipment.packedWeightGrams))).dividedBy(1000);
    return {
      chargeableExact: kg,
      unit: "kg",
      working: {
        garments: q.toFixed(),
        packedWeightGrams: String(shipment.packedWeightGrams),
        chargeableKg: kg.toFixed(3),
      },
    };
  }

  if (offer.basis === "PER_CARTON") {
    if (!present(shipment.garmentsPerCarton)) {
      return { missing: { code: CODES.CARTON_MISSING, owner: OWNER.RND } };
    }
    const perCarton = new Decimal(String(shipment.garmentsPerCarton));
    if (perCarton.isLessThanOrEqualTo(0)) {
      return { missing: { code: CODES.CARTON_MISSING, owner: OWNER.RND } };
    }
    /* ── CEILING, BECAUSE A PART CARTON IS A CARTON ──────────────────
       250 garments at 40 a carton is 7 cartons, not 6.25. The transporter
       charges for the seventh whether it is full or not. */
    const cartons = q.dividedBy(perCarton).integerValue(Decimal.ROUND_CEIL);
    return {
      chargeableExact: cartons,
      unit: "carton",
      working: {
        garments: q.toFixed(),
        garmentsPerCarton: perCarton.toFixed(),
        cartons: cartons.toFixed(),
      },
    };
  }

  return { missing: { code: CODES.NO_OFFER, owner: OWNER.STORE_PURCHASE } };
}

/**
 * The freight on one scenario: the net charge, the tax position, and the
 * working that produced it.
 *
 * The minimum charge floors the line TOTAL, not the rate — "₹35 a kg, minimum
 * ₹4,000" means a 50 kg load is charged ₹4,000 and not ₹1,750. Same rule, same
 * words, as the service register's minimum charge.
 */
function priceScenario(offer, { quantity, shipment, roundingMode = "HALF_UP", gstTreatment = null }) {
  const facts = shipmentWorking(offer, { quantity, shipment, roundingMode });
  if (facts.missing) return facts;

  /* The quotation's own net of tax, by the rule every other register uses —
     a tax-inclusive rate is un-grossed once, here, and never twice. */
  const net = offerPricing.netRateMinor(
    { priceBasis: offer.priceBasis, gstRatePercent: offer.gstRatePercent, offerId: offer.offerId },
    offer.rateMinor, roundingMode,
  );

  const beforeMinimum = facts.chargeableExact.multipliedBy(new Decimal(net.netMinor));
  const beforeMinimumMinor = roundMinor(beforeMinimum, roundingMode);
  const floor = present(offer.minimumChargeMinor) ? Number(offer.minimumChargeMinor) : null;
  const minimumApplied = floor !== null && beforeMinimumMinor < floor;
  const totalMinor = minimumApplied ? floor : beforeMinimumMinor;

  const tax = offerPricing.taxPositionFor(
    { priceBasis: offer.priceBasis, gstRatePercent: offer.gstRatePercent, offerId: offer.offerId },
    offer.priceBasis === "NON_TAXABLE" ? "NONE" : gstTreatment,
  );

  return {
    totalMinor,
    beforeMinimumMinor,
    minimumApplied,
    unit: facts.unit,
    working: facts.working,
    netRateMinor: net.netMinor,
    tax,
  };
}

module.exports = {
  ARRANGEMENTS, TREATMENT, PREPAID_TREATMENT, OWNER, CODES,
  resolveArrangement, coversLane, shipmentWorking, priceScenario,
};
