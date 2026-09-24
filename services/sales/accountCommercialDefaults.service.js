// services/sales/accountCommercialDefaults.service.js
//
// THE CUSTOMER'S USUAL COMMERCIAL TERMS, VALIDATED WHERE THEY ARE WRITTEN.
//
// The Account carries what this customer normally agrees — the advance, how
// long the balance runs and from what, and how their orders are usually
// delivered. Every enquiry is then OFFERED those terms and may depart from
// them; nothing here is read live by a costing (see
// services/sales/deliveryTermsResolution.service.js for why that matters).
//
// ── WHY THE SAME RULES AS THE ENQUIRY, AND NOT SOFTER ONES ──────────────────
// A default that could not be saved on an enquiry is a default that will be
// refused the moment somebody applies it — so "30 days" with no anchor, or a
// 100% advance with a credit period, is refused HERE too, where the person who
// knows the customer is looking at it. The messages are deliberately the
// enquiry's messages: one vocabulary, so the same mistake reads the same way
// on both screens.
//
// ── BLANK IS AN ANSWER-SHAPED HOLE, NOT A ZERO ──────────────────────────────
// Every field is optional and clearing one is a real act ("we have no standing
// advance any more"). So a submitted blank UNSETS the field rather than
// storing 0 or "", which an enum would reject and a number would misread as a
// deliberate nil.
"use strict";

const {
  FREIGHT_ARRANGEMENT_CODES, TRANSPORT_MODE_CODES, PREPAID_TREATMENT_CODES, PAYMENT_DUE_FROM,
} = require("../../constants/crm");
const { usablePercent, usableDays, knownShape, deriveShape } = require("./paymentTermsResolution.service");
const planService = require("./paymentPlan.service");

const DUE_FROM_CODES = PAYMENT_DUE_FROM.map((p) => p.code);
const str = (v) => String(v ?? "").trim();
const blank = (v) => v === null || v === undefined || v === "";

/** Every key this service owns. Anything else on the body is not its business. */
const FIELDS = Object.freeze([
  "advancePercent", "creditDays", "creditDaysFrom", "paymentTermsShape", "paymentTermsCode", "negotiatedTerms",
  "paymentPlan",
  "freightArrangement", "defaultShippingAddressId", "defaultTransportMode",
  "defaultPrepaidTreatment", "deliveryInstructions",
]);

const touches = (body = {}) => FIELDS.some((f) => f in body);

/**
 * Validate and normalise the commercial defaults in a submitted body.
 *
 * Partial by design: a PATCH that sends only `creditDays` is judged against
 * what the account already holds, because the rules are about the account's
 * resulting state and not about one keystroke.
 *
 * @param {object} body                the submitted account body
 * @param {object} [opt]
 * @param {object} [opt.existing]      the account as it stands today
 * @returns {{ok:true, values:object} | {ok:false, field:string, message:string}}
 *          `values` holds only the keys that were sent; `undefined` clears one.
 */
function validate(body = {}, { existing = null } = {}) {
  const values = {};
  const sent = (f) => f in body;
  const fail = (field, message) => ({ ok: false, field, message });

  if (sent("advancePercent")) {
    if (blank(body.advancePercent)) values.advancePercent = undefined;
    else if (usablePercent(body.advancePercent) === null) {
      return fail("advancePercent", "An advance is a percentage between 0 and 100.");
    } else values.advancePercent = usablePercent(body.advancePercent);
  }

  if (sent("creditDays")) {
    if (blank(body.creditDays)) values.creditDays = undefined;
    else if (usableDays(body.creditDays) === null) {
      return fail("creditDays", "Credit days is a whole number of days, not negative.");
    } else values.creditDays = usableDays(body.creditDays);
  }

  /* ── THE AGREEMENT THIS CUSTOMER USUALLY MAKES ────────────────────────
     The same eight terms an enquiry answers in. Absent means the account has
     never said, and the figures below are read for what they describe; an
     unrecognised code is refused rather than quietly replaced, exactly as the
     enquiry refuses one. */
  if (sent("paymentTermsShape")) {
    if (blank(body.paymentTermsShape)) values.paymentTermsShape = undefined;
    else if (!knownShape(body.paymentTermsShape)) {
      return fail("paymentTermsShape",
        "That is not a payment term this system recognises. Choose one of the listed terms.");
    } else values.paymentTermsShape = str(body.paymentTermsShape);
  }

  /* ── THE CUSTOMER'S USUAL PLAN, TRANCHE BY TRANCHE ───────────────────
     The whole agreement: what share, against which event, how far from it.
     An empty list clears it and hands the customer back to the two figures,
     which is how a plan is removed without a second endpoint. */
  if (sent("paymentPlan")) {
    const checked = planService.validate(body.paymentPlan);
    if (!checked.ok) return fail(checked.field, checked.message);
    values.paymentPlan = checked.plan.length ? checked.plan : undefined;
    /* ── AND THE ONE FIGURE THE PIPELINE ENFORCES, KEPT IN STEP ──────
       Production does not start until the agreed advance has been received,
       and that gate reads `advancePercent`. It is DERIVED from the plan
       here — the share agreed before production starts — rather than typed
       beside it, because a plan and a figure that disagree about the same
       customer is one of them being wrong on an order somebody ships. */
    if (checked.plan.length) {
      const upfront = planService.upfrontShare(checked.plan);
      if (upfront !== null) values.advancePercent = upfront;
      const named = planService.shapeOf(checked.plan);
      if (named) values.paymentTermsShape = named;
    }
  }

  if (sent("creditDaysFrom")) {
    if (blank(body.creditDaysFrom)) values.creditDaysFrom = undefined;
    else if (!DUE_FROM_CODES.includes(str(body.creditDaysFrom))) {
      return fail("creditDaysFrom", "Choose what the days are counted from.");
    } else values.creditDaysFrom = str(body.creditDaysFrom);
  }

  /* ── THE RESULTING STATE, NOT THE KEYSTROKE ───────────────────────────── */
  const advance = "advancePercent" in values
    ? values.advancePercent ?? null : usablePercent(existing?.advancePercent);
  const days = "creditDays" in values
    ? values.creditDays ?? null : usableDays(existing?.creditDays);
  const from = "creditDaysFrom" in values
    ? values.creditDaysFrom ?? "" : str(existing?.creditDaysFrom);

  /* A full advance leaves no balance, so a credit period against it is two
     statements that contradict each other. The enquiry refuses the same pair,
     by the same name. */
  if (advance === 100 && days !== null && days > 0) {
    return fail("creditDays",
      "A 100% advance leaves no balance outstanding. Clear the credit period, or reduce the advance.");
  }
  /* A duration with no anchor cannot be offered to an enquiry as a term: the
     enquiry would refuse it at confirmation, so it is refused at the source. */
  if (days !== null && days > 0 && !DUE_FROM_CODES.includes(from)) {
    return fail("creditDaysFrom",
      "Say what the days are counted from — thirty days from the invoice and from the bill of lading "
      + "differ by the whole shipping time.");
  }

  /* ── AND A CUSTOM STANDING TERM SAYS WHAT IS CUSTOM ABOUT IT ──────────
     The same rule the enquiry applies, in the same words, for the same
     reason: "Custom" is the choice for everything the seven named terms
     cannot describe, so it is the one that can be recorded meaning nothing —
     and a default that would be refused the moment somebody applied it is
     refused here, where the person who knows this customer is looking at it.

     An account that has never named its agreement is untouched by this: it
     has no shape, its figures are read for what they describe, and nothing
     is asked of it. */
  const plan = "paymentPlan" in values
    ? values.paymentPlan || [] : (Array.isArray(existing?.paymentPlan) ? existing.paymentPlan : []);
  const shape = "paymentTermsShape" in values
    ? values.paymentTermsShape ?? "" : str(existing?.paymentTermsShape);
  const wording = sent("negotiatedTerms") ? str(body.negotiatedTerms) : str(existing?.negotiatedTerms);
  const figuresSayIt = deriveShape({ advancePercent: advance, creditDays: days, creditDaysFrom: from }) === "CUSTOM"
    && (advance > 0 || days > 0);
  /* A plan says what it is by saying every instalment, so "Custom" over a
     plan is asked for nothing further — it is only a figures-only record
     that has to write the agreement down. */
  if (shape === "CUSTOM" && !plan.length && !wording && !figuresSayIt) {
    return fail("negotiatedTerms",
      "Write this customer's custom terms as they were agreed. These figures on their own do not say "
      + "what makes the agreement custom.");
  }

  if (sent("freightArrangement")) {
    if (blank(body.freightArrangement)) values.freightArrangement = undefined;
    else if (!FREIGHT_ARRANGEMENT_CODES.includes(str(body.freightArrangement))) {
      return fail("freightArrangement", "That is not a delivery arrangement this system recognises.");
    } else values.freightArrangement = str(body.freightArrangement);
  }

  if (sent("defaultTransportMode")) {
    if (blank(body.defaultTransportMode)) values.defaultTransportMode = undefined;
    else if (!TRANSPORT_MODE_CODES.includes(str(body.defaultTransportMode).toUpperCase())) {
      return fail("defaultTransportMode", "That is not a freight mode this system recognises.");
    } else values.defaultTransportMode = str(body.defaultTransportMode).toUpperCase();
  }

  if (sent("defaultPrepaidTreatment")) {
    if (blank(body.defaultPrepaidTreatment)) values.defaultPrepaidTreatment = undefined;
    else if (!PREPAID_TREATMENT_CODES.includes(str(body.defaultPrepaidTreatment))) {
      return fail("defaultPrepaidTreatment",
        "Say whether prepaid freight sits inside the price or is recovered separately.");
    } else values.defaultPrepaidTreatment = str(body.defaultPrepaidTreatment);
  }

  const arrangement = "freightArrangement" in values
    ? values.freightArrangement ?? "" : str(existing?.freightArrangement);
  const treatment = "defaultPrepaidTreatment" in values
    ? values.defaultPrepaidTreatment ?? "" : str(existing?.defaultPrepaidTreatment);
  /* ── THE QUESTION ONLY PREPAID ASKS ───────────────────────────────────
     "We pay the carrier, and it is absorbed into the price" is meaningless
     beside an ex-works term, and would be offered to an enquiry that has no
     such question. Cleared rather than refused when the arrangement moves
     away from prepaid — the customer changed their usual terms, they did not
     make a mistake. */
  if (treatment && arrangement !== "prepaid") {
    values.defaultPrepaidTreatment = undefined;
  }
  if (arrangement === "prepaid" && !treatment) {
    return fail("defaultPrepaidTreatment",
      "This customer's orders are prepaid: the company pays the carrier. Say whether that freight is "
      + "usually inside the quoted price or recovered separately.");
  }

  if (sent("defaultShippingAddressId")) {
    values.defaultShippingAddressId = blank(body.defaultShippingAddressId)
      ? undefined : str(body.defaultShippingAddressId);
  }
  if (sent("deliveryInstructions")) {
    values.deliveryInstructions = str(body.deliveryInstructions).slice(0, 1000) || undefined;
  }
  if (sent("paymentTermsCode")) values.paymentTermsCode = str(body.paymentTermsCode) || undefined;
  if (sent("negotiatedTerms")) values.negotiatedTerms = str(body.negotiatedTerms) || undefined;

  return { ok: true, values };
}

/**
 * Is this address one of THIS account's shipping addresses?
 *
 * Needs the database, so it is separate from the pure rules above. The account
 * itself has already been read under the caller's company clause by the route,
 * which is what makes this a company check as well as an account one: an
 * address on somebody else's account is refused exactly as one that does not
 * exist.
 *
 * @returns {Promise<{ok:true} | {ok:false, field:string, message:string}>}
 */
async function assertShippingAddress(Address, { accountId, addressId }) {
  const doc = await Address.findOne({ _id: addressId, accountId, isActive: true })
    .select("addressType").lean()
    .catch(() => null);
  if (!doc) {
    return {
      ok: false, field: "defaultShippingAddressId",
      message: "That delivery address is not on this customer's account.",
    };
  }
  if (str(doc.addressType) !== "shipping") {
    return {
      ok: false, field: "defaultShippingAddressId",
      message: `That is the ${doc.addressType} address. Choose a shipping address, or add one to this customer.`,
    };
  }
  return { ok: true };
}

module.exports = { FIELDS, touches, validate, assertShippingAddress };
