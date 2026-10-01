// services/centralCosting/salesBrief.service.js
//
// WHAT SALES ASKED TO BE COSTED — READ, NEVER RECEIVED.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// Four commercial facts that arrived on the calculation payload and were typed
// in the Central Costing workspace:
//
//   · which of several SampleStyles this costing is about;
//   · the run sizes to price, and which of them is primary;
//   · the unit those quantities are in;
//   · the proposed selling price per run size, and the costing note.
//
// Every one is a commercial decision. Which style is being quoted, what
// quantities the customer wants priced and what the company proposes to sell
// at are Sales' — they have the customer, the negotiation and the order in
// front of them. A person opening a calculation engine has none of that, and
// none of what they typed survived anywhere Sales could read it back.
//
// So Costing READS the brief Sales confirmed. It cannot be sent one, and it
// cannot proceed without one.
//
// ── AND AN ABSENT BRIEF IS A BLOCK, NOT A DEFAULT ───────────────────────────
// No brief, or one nobody confirmed, means nobody has asked for anything to be
// costed. The refusal names Sales and the screen. Nothing is defaulted: not a
// quantity, not a unit, not a price, and above all not a style — picking one
// by ordering is how a costing comes to describe the wrong garment.
"use strict";

const { fail } = require("../storePurchase/errors");
const { dec } = require("./decimal");

const str = (v) => String(v ?? "").trim();

const costingBrief = () => require("../sales/costingBrief.service");
const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");

/** Where Sales records it, named on every refusal this file raises. */
const OWNER = Object.freeze({
  department: "Sales",
  recordedIn: "Enquiry · Costing brief",
  /* A refusal with no address is what sent people to type the figures into
     the costing in the first place. */
  briefAt: "/sales/dashboard/enquiries",
});

/**
 * The confirmed brief for the product this costing is about.
 *
 * @param {object} ctx      resolved company scope
 * @param {object} costing  the stored costing — its context is the ONLY source
 *   of the enquiry and the product. A caller-supplied enquiry would be a
 *   caller choosing which brief to be costed against.
 * @returns {Promise<object>} the brief view
 * @throws COSTING_BRIEF_REQUIRED when Sales has not confirmed one
 */
async function requireConfirmedBrief(ctx, costing) {
  const context = costing?.context || {};
  if (str(context.type) !== "ENQUIRY_STYLE") {
    /* Ad-hoc and historical costings have no enquiry and no brief. They are
       also unrevisable, so this is unreachable from a request — stated so an
       internal caller gets a named refusal rather than a null. */
    throw fail("COSTING_TECHNICAL_CONTEXT_NOT_SUPPORTED",
      "Only a costing raised against an enquiry product has a Sales brief.",
      { reason: "CONTEXT_HAS_NO_BRIEF", contextType: str(context.type) });
  }

  const enquiry = await enquiryModel().findOne({
    _id: context.primaryId,
    companyId: ctx.companyId,
    isActive: true,
  }).select("enquiryId costingBriefs").lean();

  /* Missing, inactive and foreign land here with one body — the same rule
     `contextResolver` applies, and for the same reason. */
  if (!enquiry) {
    throw fail("COSTING_BRIEF_REQUIRED",
      "This costing's enquiry could not be read, so there is no brief to cost against.",
      { reason: "ENQUIRY_NOT_READABLE", owner: OWNER });
  }

  const brief = costingBrief().confirmedBriefOn(enquiry, context.externalKey);
  if (!brief) {
    throw fail("COSTING_BRIEF_REQUIRED",
      "Sales has not confirmed a costing brief for this product. "
      + "The brief says which approved style is being quoted, what quantities to price and in what unit — "
      + "none of which a costing may decide for itself.",
      {
        reason: "NO_CONFIRMED_BRIEF",
        owner: OWNER,
        enquiryRef: str(enquiry.enquiryId),
        product: str(context.externalKey),
      });
  }
  return brief;
}

/**
 * The brief, in the shape the engine and the assembly already speak.
 *
 * ── ONE UNIT FOR THE WHOLE BRIEF ────────────────────────────────────────────
 * The unit used to be per scenario, which let one costing quote 500 pieces
 * beside 500 metres. It is stated once by Sales and stamped onto every
 * quantity here, so the two cannot disagree.
 */
/**
 * A proposed price, as canonical money.
 *
 * ── EXACT, BECAUSE A PRICE IS MONEY ─────────────────────────────────────────
 * Sales records the amount the way they say it — "412.50" — and the engine's
 * contract is integer minor units with a currency. The conversion is exact
 * decimal: `Number("412.50") * 100` is 41249.999999999993 on some values, and
 * a price rounded by floating point is a price nobody proposed.
 */
function toMoney(amount, currency) {
  const minor = dec(amount, { field: "proposedSellingPriceExclTax", allowNegative: false })
    .multipliedBy(100)
    .integerValue(6 /* ROUND_HALF_UP */);
  return { amountMinor: Number(minor.toFixed()), currency: str(currency) || "INR" };
}

function toCalculationInput(brief) {
  const scenarios = (brief.quantities || []).map((q) => ({
    key: str(q.key),
    label: str(q.label) || str(q.key),
    quantity: str(q.quantity),
    ...(brief.quantityUom ? { quantityUom: str(brief.quantityUom) } : {}),
    isPrimary: q.isPrimary === true,
    ...(q.proposedSellingPriceExclTax
      ? { proposedSellingPriceExclTax: toMoney(q.proposedSellingPriceExclTax, brief.currency) }
      : {}),
  }));

  return {
    scenarios,
    /* The style Sales chose, and the only way one is chosen. */
    technicalStyleId: str(brief.sampleStyleId),
    /* Sales' own words about why this is being quoted. */
    note: str(brief.note).slice(0, 500),
  };
}

/**
 * What a frozen version records about the request it answered.
 *
 * The brief's identity AND its revision: a reader can then say exactly which
 * wording of the request this version was calculated from, and tell it from
 * the wording Sales used a week later.
 */
function briefProvenance(brief) {
  return {
    sourceType: "SALES_COSTING_BRIEF",
    sourceKey: `costing-brief:${str(brief.briefId)}`,
    label: `Sales brief — ${str(brief.styleCode) || str(brief.styleReference) || "style"}`.slice(0, 300),
    /* A confirmed commercial decision with a named author, not a guess. */
    confidence: "VERIFIED",
    capturedAt: new Date(),
    snapshot: [
      { key: "briefId", text: str(brief.briefId) },
      { key: "briefRevision", text: String(brief.revision ?? 0) },
      { key: "sampleStyleId", text: str(brief.sampleStyleId) },
      { key: "styleCode", text: str(brief.styleCode) },
      { key: "quantityUom", text: str(brief.quantityUom) },
      { key: "currency", text: str(brief.currency) },
      { key: "confirmedBy", text: str(brief.confirmedByName) },
      {
        key: "confirmedAt",
        text: brief.confirmedAt ? new Date(brief.confirmedAt).toISOString() : "",
      },
    ].filter((f) => f.text),
  };
}

module.exports = { OWNER, requireConfirmedBrief, toCalculationInput, briefProvenance };
