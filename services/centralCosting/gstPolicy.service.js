// services/centralCosting/gstPolicy.service.js
//
// WHETHER INPUT GST IS MONEY THE COMPANY GETS BACK, OR GARMENT COST.
//
// ── FOUR THINGS CALLED "GST", AND THIS IS ONE OF THEM ───────────────────────
//   · the RATE a supplier charges — theirs, on their quotation, varying by
//     what is bought. Recorded by Store, never decided here;
//   · RECOVERABILITY — whether eligible input tax is reclaimed or becomes part
//     of what the garment cost. One answer for the whole company, which is
//     what this policy is;
//   · customs DUTY — a different charge on a different event, with no source
//     in this system yet and deliberately not merged into this policy;
//   · OUTPUT GST — charged to the customer on a Sales invoice. Not this
//     domain at all.
//
// ── WHY IT CANNOT BE DEFAULTED ──────────────────────────────────────────────
// It is the difference between the tax being garment cost and not being
// garment cost, on every purchased line in the costing. Assuming recoverable
// under-costs every non-recoverable purchase; assuming the reverse over-costs
// the rest. So an unset policy refuses rather than guessing, and the refusal
// names the Board.
//
// ── AND THE QUOTATION STILL WINS WHERE IT SAYS SO ───────────────────────────
// A supply that is not taxable at all says so on its own quotation
// (`priceBasis: "NON_TAXABLE"`), and `offerPricing.taxPositionFor` refuses a
// company treatment on one rather than applying it. The Board decides how
// ELIGIBLE input tax is treated; it does not decide what is taxable.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");

const POLICY_KEY = "GST_TAX_POLICY";

/** Whose gap it is. One owner: nothing a department records changes it. */
const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company input GST treatment" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "GST_POLICY_MISSING",
});

/**
 * The treatment in force, reduced to what a calculation needs. Pure.
 *
 * There is only one field, so "complete" is "stated" — but it is still
 * checked here rather than assumed, because a draft the Board never approved
 * and a version approved for next quarter both reach this function as `null`.
 */
function treatmentOf(policy = null) {
  const treatment = policy?.gst?.inputGstTreatment || null;
  if (!treatment) {
    return {
      state: STATE.POLICY_MISSING,
      inputGstTreatment: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: policy
          ? "The Board's input GST policy in force does not state a treatment."
          : "The Board has not said whether this company reclaims eligible input GST or carries it as "
            + "product cost. It is the difference between the tax being garment cost and not being "
            + "garment cost, and it is not assumed either way.",
      }],
    };
  }
  return { state: STATE.APPLIED, inputGstTreatment: treatment, missing: [] };
}

/**
 * The treatment for this company on this costing's date.
 *
 * Against the COSTING'S OWN date, never against now — a costing dated in
 * March is priced at March's treatment, and a policy approved since (even one
 * backdated) is simply not the version this query selects.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return { policy: policy || null, ...treatmentOf(policy) };
}

/**
 * The one name quotation pricing reads, as an overlay on the policy object.
 *
 * ── WHY AN OVERLAY AND NOT A CHANGE TO THE PRICING ──────────────────────────
 * `offerPricing.taxPositionFor` is the single place a tax position is decided,
 * and it is right: it refuses `NONE` as an absence of an opinion, refuses a
 * treatment on a non-taxable quotation, and refuses a taxable quotation with
 * no recorded rate rather than calling it zero-rated. Keeping its input shape
 * and changing only what fills it means the arithmetic, the refusals and the
 * quotation's own precedence are untouched by this migration.
 *
 * One overlay reaches every family, because all four paths — materials,
 * packaging, outside services and bought-in development, freight — are handed
 * `policy.inputGstTreatment` from this same object.
 *
 * The legacy field is dropped rather than fallen back to: an unapproved value
 * applied under a Board-governed family would be that value being treated as
 * Board-approved.
 */
function overlayFor(resolved) {
  return {
    inputGstTreatment: resolved?.state === STATE.APPLIED ? resolved.inputGstTreatment : undefined,
  };
}

/**
 * What gets frozen onto the version.
 *
 * ── THE DECISION, NOT THE ARITHMETIC ────────────────────────────────────────
 * The per-line workings are already frozen and stay where they are: each cost
 * line carries `tax.treatment` and `tax.ratePercent`, each scenario's line
 * result carries `taxMinor`, each scenario carries `recoverableTaxMinor`, and
 * `offerProvenance` carries the quotation's own `gstRatePercent` and the offer
 * it came from. What no version could say is WHICH company decision produced
 * the treatment on those lines, and when it was approved.
 *
 * Copied by value, like every other Board provenance block: the id so the
 * decision can be found, the rest so it can be checked without finding it.
 */
function freeze({ resolved, asOf = new Date() }) {
  const policy = resolved?.policy || null;
  return {
    state: resolved?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    inputGstTreatment: resolved?.inputGstTreatment || null,
    asOf,
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, CODES,
  treatmentOf, resolveFor, overlayFor, freeze,
};
