// services/centralCosting/approvedOutput.service.js
//
// THE ONE COMMERCIAL NUMBER SALES MAY QUOTE.
//
// ── WHAT SALES GETS, AND WHAT THEY DO NOT ───────────────────────────────────
// An approved costing version holds two very different things: what the
// garment is estimated to COST, and what the company decided to SELL it for.
// Sales needs the second and must never receive the first. A buyer who can see
// a supplier's quoted rate can work out the mill's margin; a customer-facing
// negotiator who can see the company's own margin negotiates against it.
//
// So this is not "the version with some fields removed in React". It is a
// separate, narrow read that never loads the cost block at all, gated on
// `costing.output.read` — the capability that already means "may read the
// approved commercial output", and which `visibility.js` has always kept
// distinct from `cost.read` and `margin.read`.
//
// ── AND WHY IT WILL NOT GUESS ───────────────────────────────────────────────
// A quotation for 1,200 pieces against a costing approved at 1,000 is not a
// 1,000-piece price. Fixed costs are diluted over the run, so the per-garment
// figure at 1,200 is a different number that nobody has approved. The nearest
// scenario is not offered, the price is not scaled, and the currency is not
// converted. Where there is no exact match the answer is that there is none.

"use strict";

const mongoose = require("mongoose");
const { Decimal } = require("./decimal");
const technicalSource = require("./technicalSource.service");

const Costing = () => require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = () => require("../../models/CMS_Models/Costing/CostingVersion");
const SampleStyle = () => require("../../models/CMS_Models/Sales/SampleStyle");

/* Why an approved price is not available. Each is a different thing for Sales
   to do, so they are never collapsed into one "unavailable". */
const UNAVAILABLE = Object.freeze({
  NO_STYLE: "NO_STYLE",
  NO_COSTING: "NO_COSTING",
  NO_APPROVED_VERSION: "NO_APPROVED_VERSION",
  NO_SCENARIO_FOR_QUANTITY: "NO_SCENARIO_FOR_QUANTITY",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  /* A tier was asked of a version that has one floor price. A controlled
     refusal, not a fallback: silently answering with the floor would put a
     price on a quotation under a tier name the version never had. */
  PRICE_TIER_RETIRED: "PRICE_TIER_RETIRED",
});

const REASON_TEXT = Object.freeze({
  NO_STYLE: "This quotation line is not linked to a style, so there is no costing to read.",
  NO_COSTING: "No costing has been raised for this style.",
  NO_APPROVED_VERSION: "This style has a costing, but no version has been approved yet.",
  NO_SCENARIO_FOR_QUANTITY:
    "No approved price exists for this quantity. Add the quantity to the costing and obtain approval before using a costing price.",
  PRICE_TIER_RETIRED:
    "This costing is priced by the company's pricing floor, not by minimum/target/preferred tiers.",
  CURRENCY_MISMATCH: "The approved costing is in a different currency from this quotation.",
});

const present = (v) => v !== null && v !== undefined && v !== "";
const id = (v) => (v ? String(v) : null);

/** Same quantity, however it was typed. Never "close enough". */
function sameQuantity(a, b) {
  if (!present(a) || !present(b)) return false;
  try {
    const x = new Decimal(String(a));
    const y = new Decimal(String(b));
    return x.isFinite() && y.isFinite() && x.isEqualTo(y);
  } catch {
    return false;
  }
}

const unavailable = (code, extra = {}) => ({
  available: false,
  reason: code,
  message: REASON_TEXT[code],
  ...extra,
});

/**
 * The style a quotation line names, proved to belong to this company.
 *
 * ── THE JOIN IS AN ID, NEVER A NAME ─────────────────────────────────────────
 * A quotation line carries `stockItemId` and free text. Matching a costing by
 * product name or SKU would price a line from whatever else happened to be
 * called the same thing, and matching by array position would break the first
 * time somebody reordered the items. The line names a SampleStyle explicitly,
 * and that is the only accepted key.
 *
 * SampleStyle has no company of its own, so ownership is proved through its
 * Sales Journey — the same proof the technical importer uses, imported from it
 * rather than restated, so the two cannot drift apart.
 */
async function styleSubjectFor(ctx, sampleStyleId) {
  if (!mongoose.Types.ObjectId.isValid(String(sampleStyleId || ""))) return null;
  const style = await SampleStyle()
    .findById(sampleStyleId)
    .select("sampleStyleId styleCode productName variantLabel variantKey journeyId enquiryId")
    .lean();
  if (!style) return null;
  const owned = await technicalSource.ownershipProofFor(style, ctx.companyId);
  /* Another company's style is not reported as forbidden — it is reported as
     absent, exactly as one that does not exist. */
  if (!owned) return null;
  return { style, ownershipProof: owned.proof };
}

/**
 * The approved commercial output for one style, at one quantity.
 *
 * @param {{companyId, actorId}} ctx
 * @param {object} args  sampleStyleId, quantity, currency (the quotation's)
 */
async function approvedOutputFor(ctx, { sampleStyleId, quantity, currency } = {}) {
  const subject = await styleSubjectFor(ctx, sampleStyleId);
  if (!subject) return unavailable(UNAVAILABLE.NO_STYLE);
  const { style } = subject;

  /* The costing raised against THIS enquiry product. `ENQUIRY_STYLE` is keyed
     by the enquiry id and the product name — the pair the costing context
     stores — and both come from the style record, not from the caller. */
  const costing = await Costing().findOne({
    companyId: ctx.companyId,
    "context.type": "ENQUIRY_STYLE",
    "context.primaryId": style.enquiryId,
    "context.externalKey": style.productName,
  }).select("_id label context approvedVersionId currentVersionId").lean();
  if (!costing) {
    return unavailable(UNAVAILABLE.NO_COSTING, { style: styleIdentity(style) });
  }
  if (!costing.approvedVersionId) {
    return unavailable(UNAVAILABLE.NO_APPROVED_VERSION, {
      style: styleIdentity(style), costingId: id(costing._id),
    });
  }

  /* ── ONLY THE APPROVED VERSION, AND ONLY ITS OUTPUT ────────────────────
     A narrow projection: the cost lines, the build-up, the supplier
     provenance, the margin band and the profit bridge are not selected, so
     they are never in memory to leak. Hiding them later in React would mean
     the data had already crossed the boundary. */
  const version = await CostingVersion().findOne({
    _id: costing.approvedVersionId,
    companyId: ctx.companyId,
    status: "APPROVED",
  }).select([
    "versionNumber status baseCurrency",
    "scenarios.key scenarios.label scenarios.quantity scenarios.quantityUom scenarios.isPrimary",
    "scenarios.prices scenarios.floor",
    "lifecycle.approvedAt lifecycle.approvedBy",
    "calculation.calculatedAt",
  ].join(" ")).lean();
  if (!version) {
    return unavailable(UNAVAILABLE.NO_APPROVED_VERSION, {
      style: styleIdentity(style), costingId: id(costing._id),
    });
  }

  /* ── THE CURRENCY IS NOT CONVERTED ────────────────────────────────────
     A rate nobody recorded is not a price anybody approved. */
  if (present(currency) && String(currency).toUpperCase() !== String(version.baseCurrency).toUpperCase()) {
    return unavailable(UNAVAILABLE.CURRENCY_MISMATCH, {
      style: styleIdentity(style),
      costingId: id(costing._id),
      approvedCurrency: version.baseCurrency,
      quotationCurrency: String(currency).toUpperCase(),
    });
  }

  const scenarios = (version.scenarios || []).map((s) => quantityBreak(s));

  /* No quantity asked for: the whole approved break list, for a screen that
     wants to show what IS available. */
  if (!present(quantity)) {
    return ready({ style, costing, version, scenarios, match: null });
  }

  /* ── EXACT, OR NOTHING ────────────────────────────────────────────────
     1,200 against a costing approved at 1,000 is not a 1,000-piece price:
     fixed costs are diluted over the run, so the per-garment figure at 1,200
     is a different number nobody has approved. */
  const match = scenarios.find((s) => sameQuantity(s.quantity, quantity)) || null;
  if (!match) {
    return unavailable(UNAVAILABLE.NO_SCENARIO_FOR_QUANTITY, {
      style: styleIdentity(style),
      costingId: id(costing._id),
      approvedVersionId: id(version._id),
      approvedVersionNumber: version.versionNumber,
      /* What IS approved, so Sales can see the gap rather than guess at it. */
      availableQuantities: scenarios.map((s) => s.quantity),
    });
  }
  return ready({ style, costing, version, scenarios, match });
}

const styleIdentity = (style) => ({
  sampleStyleId: id(style._id),
  styleReference: style.sampleStyleId || "",
  styleCode: style.styleCode || "",
  productName: style.productName || "",
  variantLabel: style.variantLabel || "",
});

/**
 * One approved quantity break.
 *
 * The three tiers the policy produced, and nothing about how they were
 * reached: no unit cost, no margin percentage, no basis. A price and the
 * quantity it is for is the whole of what Sales quotes.
 */
const quantityBreak = (s) => ({
  scenarioKey: s.key,
  label: s.label || "",
  quantity: s.quantity,
  quantityUom: s.quantityUom || null,
  isPrimary: Boolean(s.isPrimary),
  /* ── ONE FLOOR PRICE, AND NOTHING BEHIND IT ────────────────────────
     The PRICE only. `floorMarkupPercent`, `trueUnitCostMinor` and
     `markupAmountMinor` live on the same subdocument and are deliberately not
     carried: a reader entitled to a price is not thereby entitled to the
     company's cost or to what the Board marks it up by.

     Null on a version frozen under the retired band, which carries its three
     tiers below instead. */
  floorPriceMinor: s.floor?.floorPriceMinor ?? null,
  pricingContract: s.floor ? "MARKUP_FLOOR_V2" : (s.prices?.minimum ? "MARGIN_BAND_V1" : null),

  /* ── AND THE RETIRED TIERS, ON HISTORICAL VERSIONS ONLY ────────────
     `requestedMarginPercent` and `effectiveMarginPercent` live on the same
     subdocument and are deliberately not carried. Null on every new version,
     because no new version has them. */
  minimumPriceMinor: s.prices?.minimum?.priceMinor ?? null,
  targetPriceMinor: s.prices?.target?.priceMinor ?? null,
  preferredPriceMinor: s.prices?.preferred?.priceMinor ?? null,
});

function ready({ style, costing, version, scenarios, match }) {
  return {
    available: true,
    reason: null,
    style: styleIdentity(style),
    costingId: id(costing._id),
    costingLabel: costing.label || "",
    approvedVersionId: id(version._id),
    approvedVersionNumber: version.versionNumber,
    /* Whether this is STILL the costing's approved version. It is, by
       construction here — the pointer is what was read — and it is returned so
       a saved quotation line can be compared against it later. */
    isCurrentApproval: String(costing.approvedVersionId) === String(version._id),
    currency: version.baseCurrency,
    approvedAt: version.lifecycle?.approvedAt || null,
    calculatedAt: version.calculation?.calculatedAt || null,
    quantityBreaks: scenarios,
    match,
    /* ── WHAT SALES MUST SAY OUT LOUD ──────────────────────────────────
       The approved price EXCLUDES GST. The quotation applies tax and
       charges afterwards, and a line that quietly treated this as
       tax-inclusive would under-charge by the tax rate on every piece. */
    assumptions: [
      "This price excludes GST. The quotation adds tax and charges afterwards.",
      "It is the price approved for this exact quantity. A different quantity has a different approved price.",
    ],
  };
}

/**
 * Everything a quotation line freezes when it takes an approved price.
 *
 * ── SERVER-RESOLVED, NEVER COPIED FROM THE BROWSER ──────────────────────────
 * The client names a style, a quantity and which tier it wants. The version,
 * the price and the currency are read here. A client that could post its own
 * price would be a client that could quote any number and have the record say
 * a costing approved it.
 */
/* The identity half of a link's provenance, shared by both price shapes so a
   floor-priced line and a tier-priced one carry the same traceability. */
const provenanceBase = (out) => ({
  source: "APPROVED_COSTING",
  costingId: out.costingId,
  costingVersionId: out.approvedVersionId,
  costingVersionNumber: out.approvedVersionNumber,
  sampleStyleId: out.style.sampleStyleId,
  styleCode: out.style.styleCode,
  productName: out.style.productName,
  scenarioKey: out.match.scenarioKey,
  quantity: String(out.match.quantity),
});

/* The one price a version approved under the pricing floor carries. Not one of
   `TIERS` — it is a different claim about a price, and naming it apart is what
   stops the two being read as interchangeable. */
const FLOOR = "floor";

async function resolveLinkForLine(ctx, { sampleStyleId, quantity, currency, tier = "target" } = {}) {
  const out = await approvedOutputFor(ctx, { sampleStyleId, quantity, currency });
  if (!out.available || !out.match) return out;

  /* ── WHICH PRICE THIS VERSION HAS IS A FACT ABOUT THE VERSION ────────
     A version approved under the pricing floor has one price. A version
     frozen under the retired band has three. The caller says which it wants;
     the version says which it has, and a mismatch is refused rather than
     resolved to whatever is there. */
  if (out.match.pricingContract === "MARKUP_FLOOR_V2") {
    /* ── A TIER ASKED OF A ONE-FLOOR VERSION IS REFUSED BY NAME ────────
       Not answered with the floor. A quotation line recording `priceTier:
       "target"` against a version that never calculated a target would be a
       record asserting an approval that did not happen — and "target" and
       "floor" are commercially different claims about the same number. */
    if (tier && tier !== FLOOR) {
      return unavailable(UNAVAILABLE.PRICE_TIER_RETIRED, {
        style: out.style, costingId: out.costingId,
        message: "This costing was approved under the company's pricing floor policy, which "
          + "calculates one floor price rather than minimum, target and preferred tiers. Quote the "
          + "floor price, or a price above it.",
        floorPriceMinor: out.match.floorPriceMinor ?? null,
      });
    }
    if (!present(out.match.floorPriceMinor)) {
      return unavailable(UNAVAILABLE.NO_SCENARIO_FOR_QUANTITY, {
        style: out.style, costingId: out.costingId,
        message: "The approved version records no floor price for this quantity.",
      });
    }
    return {
      available: true,
      reason: null,
      provenance: {
        ...provenanceBase(out),
        /* Named `FLOOR`, never left as a tier: a reader of this line must be
           able to tell a floor price from one of the retired tiers without
           looking the version up. */
        priceTier: FLOOR,
        unitPriceMinor: out.match.floorPriceMinor,
        currency: out.currency,
        linkedAt: new Date(),
        approvedAt: out.approvedAt,
        assumptions: out.assumptions,
        /* The same immutable evidence a tier-priced line carries, over the
           same facts — so a floor-priced quotation can be checked against its
           source exactly as a historical one can. The tier token is `floor`,
           which is what makes the two fingerprints distinguishable. */
        fingerprint: fingerprintOf({
          costingId: out.costingId,
          versionId: out.approvedVersionId,
          scenarioKey: out.match.scenarioKey,
          tier: FLOOR,
          priceMinor: out.match.floorPriceMinor,
          currency: out.currency,
        }),
      },
    };
  }

  /* ── AND THE FLOOR ASKED OF A BAND VERSION IS REFUSED THE SAME WAY ───
       Symmetric, and for the same reason: a historical version has no floor,
       and answering with its target would put a tier's number on a line that
       says "floor". */
  if (tier === FLOOR) {
    return unavailable(UNAVAILABLE.PRICE_TIER_RETIRED, {
      style: out.style, costingId: out.costingId,
      message: "This costing was approved under the retired three-band margin policy, so it has no "
        + "floor price — it has a minimum, a target and a preferred price. Choose one of those.",
    });
  }

  const field = `${tier}PriceMinor`;
  const priceMinor = out.match[field];
  if (!present(priceMinor)) {
    return unavailable(UNAVAILABLE.NO_SCENARIO_FOR_QUANTITY, {
      style: out.style, costingId: out.costingId,
      message: `The approved version records no ${tier} price for this quantity.`,
    });
  }

  return {
    available: true,
    reason: null,
    provenance: {
      ...provenanceBase(out),
      priceTier: tier,
      unitPriceMinor: priceMinor,
      currency: out.currency,
      linkedAt: new Date(),
      approvedAt: out.approvedAt,
      assumptions: out.assumptions,
      /* ── IMMUTABLE EVIDENCE ────────────────────────────────────────────
         A fingerprint of the facts that produced this price. If a later
         reader wants to know whether the saved line still says what the
         costing said, they compare this rather than trusting that nothing
         moved. Derived from ids and figures only — no secret, so it proves
         identity, not authenticity. */
      fingerprint: fingerprintOf({
        costingId: out.costingId,
        versionId: out.approvedVersionId,
        scenarioKey: out.match.scenarioKey,
        tier,
        priceMinor,
        currency: out.currency,
      }),
    },
    output: out,
  };
}

function fingerprintOf(parts) {
  const canonical = [
    parts.costingId, parts.versionId, parts.scenarioKey,
    parts.tier, String(parts.priceMinor), parts.currency,
  ].join("|");
  return require("crypto").createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Is a saved quotation line's approved source still the current one?
 *
 * ── A SENT QUOTATION IS HISTORY, NOT A LIVE VIEW ────────────────────────────
 * This answers only what the CURRENT approval is. It never rewrites the saved
 * figure: what was offered to a customer is what was offered, and restating it
 * because a costing changed afterwards would falsify the record of the offer.
 * A DRAFT is where the answer matters, because a draft has not been sent.
 */
async function supersessionFor(ctx, provenance) {
  if (!provenance || !provenance.costingId) return { checked: false };
  const costing = await Costing().findOne({
    companyId: ctx.companyId, _id: provenance.costingId,
  }).select("approvedVersionId").lean();
  if (!costing) return { checked: true, superseded: false, unknown: true };

  const current = id(costing.approvedVersionId);
  const linked = id(provenance.costingVersionId);
  if (current && linked && current !== linked) {
    return {
      checked: true,
      superseded: true,
      linkedVersionId: linked,
      currentApprovedVersionId: current,
      message: "Approved source has been superseded",
    };
  }
  return { checked: true, superseded: false };
}

module.exports = {
  FLOOR,
  UNAVAILABLE, REASON_TEXT,
  approvedOutputFor, resolveLinkForLine, supersessionFor,
  sameQuantity, fingerprintOf, styleSubjectFor,
};
