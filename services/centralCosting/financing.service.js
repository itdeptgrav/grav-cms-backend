// services/centralCosting/financing.service.js
//
// WHAT IT COSTS THIS COMPANY TO WAIT TO BE PAID FOR THIS ORDER.
//
// ── THE TWO HALVES, AND WHY NEITHER ALONE IS A COST ─────────────────────────
// The Board says what money costs and how a duration becomes a figure. Sales
// says how long this order's money is out. Until this file existed the company
// had only the first half, and applied it as a flat percentage of a subtotal —
// which is a number with the same units as a cost of capital and none of its
// meaning. Two orders with the same materials and payment terms ninety days
// apart carried identical financing.
//
//     financing = basis × financed share × annual rate × days ÷ day count
//
// Every term on the right is a recorded decision with an owner. Nothing here
// supplies a default for any of them.
//
// ── FIVE ANSWERS, AND ONLY TWO OF THEM ARE A CALCULATION ────────────────────
//   CALCULATED      a rate, a share and a duration — a figure.
//   RECORDED_ZERO   the money is out for no time. Paid in full up front, or
//                   due immediately. That is an ANSWER somebody gave, and it
//                   is frozen with the terms that produced it.
//   NOT_APPLICABLE  Sales stated a reason financing does not apply.
//   TERMS_MISSING   nobody has agreed when this order gets paid.
//   POLICY_MISSING  the Board has not decided what money costs.
//
// The last two produce NO LINE. Not a zero — a zero here is the claim that
// this order costs nothing to finance, which is exactly what an unanswered
// question is not. `RECORDED_ZERO` and `TERMS_MISSING` both total nil and are
// different statements; keeping them apart is most of the point of this file.
//
// ── AND NOTHING IS PARSED FROM PROSE ────────────────────────────────────────
// `NET30`, "60% against BL" and `Enquiry.balanceTerms` are read by people. The
// duration used here comes from the structured, confirmed terms Sales records
// and from nowhere else.
"use strict";

const { Decimal } = require("./decimal");
const boardPolicy = require("../board/boardPolicy.service");
const paymentTerms = require("../sales/paymentTermsResolution.service");

/** Whose gap it is. Matches the vocabulary the assembly already reports with. */
const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company financing policy" },
  SALES: { department: "Sales", system: "Enquiry payment terms" },
});

const STATE = Object.freeze({
  CALCULATED: "CALCULATED",
  RECORDED_ZERO: "RECORDED_ZERO",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  TERMS_MISSING: "TERMS_MISSING",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "FINANCING_POLICY_MISSING",
  TERMS_MISSING: "PAYMENT_TERMS_MISSING",
});

const LINE_KEY = "policy:financing";

const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");

/**
 * The share of the order the company is actually financing.
 *
 * ── THE ONE PLACE THE ADVANCE IS ALLOWED TO MATTER ──────────────────────────
 * And only because the Board said so. `REDUCES_FINANCED_AMOUNT` is the common
 * answer — money already received is not money being financed — but a company
 * financing its whole working-capital cycle at a blended rate may deliberately
 * charge the full order, and both produce a defensible garment cost. Hard-
 * coding either would be this code making a Board decision.
 */
function financedShare({ advanceTreatment, advancePercent }) {
  if (advanceTreatment !== "REDUCES_FINANCED_AMOUNT") return new Decimal(1);
  const advance = advancePercent === null || advancePercent === undefined
    ? new Decimal(0)
    : new Decimal(String(advancePercent));
  const share = new Decimal(100).minus(advance).dividedBy(100);
  return share.isLessThan(0) ? new Decimal(0) : share;
}

/**
 * THE METHODOLOGY, APPLIED. Pure — no database, no clock, no context.
 *
 * Exported and tested directly, because a rule that can only be reached
 * through a costing is a rule nobody checks. Everything it needs is passed in:
 * the Board's approved methodology and Sales' confirmed projection.
 *
 * @param {object|null} policy  the effective `BoardPolicy` document, or null
 * @param {object|null} terms   `paymentTermsResolution.projectionFor(enquiry)`
 * @returns {object} `{ state, percent, basis, working, missing }` — `percent`
 *   is the EFFECTIVE percent for this order, as a decimal string, or null.
 */
function compute({ policy = null, terms = null } = {}) {
  const missing = [];

  /* ── SALES FIRST, BECAUSE IT CAN END THE QUESTION ──────────────────────
     "Financing does not apply to this order" is a commercial condition with
     a stated reason. It is an answer, and it stands whether or not the Board
     has published a rate — asking the Board to decide something before an
     intercompany transfer can be recorded as unfinanced would be asking the
     wrong person about the wrong order. */
  if (terms?.notApplicable) {
    return {
      state: STATE.NOT_APPLICABLE,
      percent: null,
      basis: policy?.financing?.basis || null,
      working: {
        reason: terms.notApplicableReason || "",
        confirmedAt: terms.confirmedAt || null,
        confirmedByName: terms.confirmedByName || "",
      },
      missing,
    };
  }

  const haveTerms = Boolean(terms) && terms.state === paymentTerms.TERMS.CONFIRMED;
  const havePolicy = Boolean(policy?.financing?.annualRatePercent && policy?.financing?.basis
    && policy?.financing?.advanceTreatment && policy?.financing?.dayCountBasis);

  /* ── BOTH GAPS ARE REPORTED, NOT THE FIRST ────────────────────────────
     They have different owners. Reporting only the Board's would leave Sales
     believing their half was done, and reporting only Sales' would leave a
     costing that never completes for a reason nobody was told. */
  if (!havePolicy) {
    missing.push({
      code: CODES.POLICY_MISSING,
      owner: OWNER.BOARD,
      message: policy
        ? "The Board's financing policy in force does not state a complete methodology, so financing cannot be calculated."
        : "The Board has not approved a financing policy for this company, so the cost of money on this order cannot be calculated. It is not nil.",
    });
  }
  if (!haveTerms) {
    missing.push({
      code: CODES.TERMS_MISSING,
      owner: OWNER.SALES,
      message: "Nobody has confirmed when this order gets paid, so there is no duration to finance. "
        + "An unanswered question is not a cash sale.",
    });
  }

  if (!havePolicy || !haveTerms) {
    return {
      state: havePolicy ? STATE.TERMS_MISSING : STATE.POLICY_MISSING,
      percent: null,
      basis: policy?.financing?.basis || null,
      working: null,
      missing,
    };
  }

  const f = policy.financing;
  const share = financedShare({
    advanceTreatment: f.advanceTreatment,
    advancePercent: terms.advancePercent,
  });
  /* A confirmed 100% advance records no credit period at all — Sales refuses
     the pair as a contradiction — so its duration is nil rather than absent.
     Reading it as absent here would turn "paid in full up front" into
     "unanswered", which is the opposite of what happened. */
  const days = new Decimal(String(terms.creditDays ?? 0));
  const rate = new Decimal(String(f.annualRatePercent));
  const dayCount = new Decimal(String(f.dayCountBasis));

  const effective = rate.times(share).times(days).dividedBy(dayCount);

  const working = {
    annualRatePercent: rate.toFixed(),
    advanceTreatment: f.advanceTreatment,
    advancePercent: terms.advancePercent === null || terms.advancePercent === undefined
      ? null : String(terms.advancePercent),
    financedSharePercent: share.times(100).toFixed(),
    creditDays: terms.creditDays ?? 0,
    creditDaysFrom: terms.creditDaysFrom || null,
    creditDaysFromLabel: terms.creditDaysFromLabel || null,
    dayCountBasis: f.dayCountBasis,
    /* Six places, kept rather than rounded to two: the effective percent is an
       intermediate, and rounding an intermediate to the precision of a
       displayed rate loses money on every large basis. The engine rounds once,
       at the end, in the company's own mode. */
    effectivePercent: effective.toFixed(6),
    /* The arithmetic in words, so the figure can be checked by hand a year
       later without anybody having to find this file. */
    formula: "basis x financed share x annual rate x credit days / day-count basis",
  };

  /* ── A DURATION OF NOTHING IS AN ANSWER ───────────────────────────────
     Zero credit days, or a full advance the Board's methodology removes from
     the financed amount. The company waits for no money and that is a fact
     somebody recorded, so it is a line with a zero on it rather than an
     absent family. */
  if (effective.isZero()) {
    return {
      state: STATE.RECORDED_ZERO,
      percent: "0",
      basis: f.basis,
      working,
      missing,
    };
  }

  return { state: STATE.CALCULATED, percent: working.effectivePercent, basis: f.basis, working, missing };
}

/**
 * The two records this order's financing rests on, read.
 *
 * The Board policy is resolved against the COSTING'S OWN DATE, never against
 * now: a costing dated in March is calculated at March's methodology, and a
 * policy approved since — even one backdated — is simply not the one this
 * query selects.
 */
async function readFinancingSource(ctx, { enquiryId = null, asOf = new Date() } = {}) {
  const [policy, enquiry] = await Promise.all([
    boardPolicy.resolveEffective(ctx.companyId, "FINANCING", asOf).catch(() => null),
    enquiryId
      /* The model module, not `mongoose.model("Enquiry")` — a name lookup
         throws synchronously when the model has not been registered yet, and
         it would throw out of this function before any `.catch` could see it.
         Required lazily like the rest of this folder does it, so a pure test
         of `compute` needs no mongoose registry at all. */
      ? enquiryModel()
        .findOne({ _id: enquiryId, companyId: ctx.companyId })
        .select("paymentTerms enquiryId")
        .lean()
        .catch(() => null)
      : null,
  ]);

  return {
    policy: policy || null,
    /* Sales' own projection, not a second reading of the enquiry. One
       interpretation of confirmed terms, shared by the screen that shows a
       department its gaps and the engine that prices them. */
    terms: enquiry ? paymentTerms.projectionFor(enquiry) : null,
    enquiryRef: enquiry?.enquiryId ? String(enquiry.enquiryId) : "",
  };
}

/**
 * What gets frozen onto the version.
 *
 * ── EVERY DECISION THE FIGURE RESTED ON, BY VALUE ───────────────────────────
 * Not a pointer to the Board policy: a reference would be re-read, and re-
 * reading is how a later approval silently restates an old costing. The
 * version keeps the id so the decision can be FOUND, and the values so it can
 * be CHECKED without finding it.
 */
function freeze({ result, policy, terms, enquiryRef = "", asOf = new Date() }) {
  const f = policy?.financing || {};
  return {
    lineKey: LINE_KEY,
    state: result.state,
    /* The Board decision, identified and copied. */
    boardPolicyId: policy?._id || null,
    policyKey: policy?.policyKey || "FINANCING",
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    annualRatePercent: f.annualRatePercent ?? null,
    basis: result.basis || null,
    advanceTreatment: f.advanceTreatment || null,
    dayCountBasis: f.dayCountBasis ?? null,
    /* The Sales facts, copied for the same reason. */
    enquiryRef,
    termsState: terms?.state || null,
    advancePercent: terms?.advancePercent === null || terms?.advancePercent === undefined
      ? null : String(terms.advancePercent),
    creditDays: terms?.creditDays ?? null,
    creditDaysFrom: terms?.creditDaysFrom || null,
    termsSource: terms?.source || null,
    termsConfirmedAt: terms?.confirmedAt || null,
    termsConfirmedByName: terms?.confirmedByName || "",
    notApplicableReason: result.state === STATE.NOT_APPLICABLE
      ? (terms?.notApplicableReason || "") : "",
    /* And the arithmetic, so nobody has to reconstruct it. */
    financedSharePercent: result.working?.financedSharePercent ?? null,
    effectivePercent: result.percent ?? null,
    formula: result.working?.formula || null,
    asOf,
  };
}

module.exports = { OWNER, STATE, CODES, LINE_KEY, financedShare, compute, readFinancingSource, freeze };
