// services/centralCosting/marginPolicy.service.js
//
// THE PRICING FLOOR: WHAT THE COMPANY IS PREPARED TO SELL FOR.
//
// ── ONE MARKUP, ONE FLOOR ───────────────────────────────────────────────────
// Management sets one percentage. Central Costing turns it into one number per
// quantity break:
//
//     floor price = true unit cost x (1 + markup% / 100)
//
// A markup, on the COST. Not a margin, on the price. The two are different
// arithmetic and the gap between them is real money:
//
//     markup 20% on Rs 500  ->  500 x 1.20        = Rs 600
//     margin 20% on Rs 500  ->  500 / (1 - 0.20)  = Rs 625
//
// Sales may quote above the floor freely. Below it is a management decision,
// and this module publishes the STANDING that such a decision would act on --
// it does not implement the acting.
//
// ── THE FILE KEEPS ITS NAME, AND THE POLICY KEEPS ITS KEY ───────────────────
// `MARGIN_POLICY` is the lineage: the key every frozen version names, the key
// the effective-date supersession index is built on, and the key a company's
// approval history hangs off. Renaming it would have orphaned all of that and
// allowed two pricing policies to be in force at once. The CONTRACT is
// versioned instead -- `MARGIN_BAND_V1` for what is now history,
// `MARKUP_FLOOR_V2` for what is decided now.
//
// ── AND NOTHING CONVERTS ONE INTO THE OTHER ─────────────────────────────────
// A company's approved 20% margin is not a 20% markup. Re-reading it as one
// would move every floor price in the company without anybody deciding to, so
// the first V2 draft starts empty and the Board states a number.
//
// WHAT THE COMPANY IS PREPARED TO SELL FOR.
//
// ── THE ONE POLICY WHOSE ABSENCE STOPS THE ARITHMETIC ───────────────────────
// Overhead, GST, contingency and development charges are costs the engine adds
// or does not add: a company with none of them still gets a costing, with the
// gaps named. The margin band is not like that. `engine.js` reads all three
// figures as REQUIRED, refuses `undefined`, and solves
//
//     selling price = cost / (1 - margin)
//
// for every price break from them. Without a band there is no price to solve
// for, and a costing with no price is not a costing.
//
// ── WHICH IS EXACTLY WHY THE ZERO MUST NOT BE INVENTED ──────────────────────
// `CostingPolicy` defaulted the three to "0" and carried a separate
// `configured` flag to say whether anybody meant them. The flag worked, and
// `profitBridge.standingOf` still honours it — a band of zeroes with
// `configured: false` reports `NO_POLICY` rather than "every price is
// acceptable". What the flag could never carry is WHO decided the band and
// from when.
//
// So this module fills the three names only from an APPROVED decision. When
// none exists it fills nothing and says so, and the caller refuses the costing
// rather than pricing it at a margin nobody chose. An approved band of 0/0/0
// is a completely different record: somebody put their name to it.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");
const { Decimal, ceilToIncrement } = require("./decimal");

const POLICY_KEY = "MARGIN_POLICY";

const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company margin and profit guardrails" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  POLICY_MISSING: "POLICY_MISSING",
  /* An approved version that predates the floor contract. It is a real
     decision and it priced real quotations; it just cannot price a NEW one,
     because the band it carries is not a markup and must not be read as one. */
  LEGACY_BAND: "LEGACY_BAND",
});

const CODES = Object.freeze({
  POLICY_MISSING: "MARGIN_POLICY_MISSING",
});

/* ── WHERE A PROPOSED PRICE STANDS AGAINST THE FLOOR ────────────────────────
 * Three, and only three. `BELOW_FLOOR` is the one that means somebody has to
 * decide something; publishing it is this module's job and acting on it is
 * not. `POLICY_MISSING` is emphatically not "at or above" -- a price cannot
 * clear a floor that does not exist. */
const STANDING = Object.freeze({
  AT_OR_ABOVE_FLOOR: "AT_OR_ABOVE_FLOOR",
  BELOW_FLOOR: "BELOW_FLOOR",
  POLICY_MISSING: "POLICY_MISSING",
});

const STANDING_LABEL = Object.freeze({
  AT_OR_ABOVE_FLOOR: "At or above the floor price",
  BELOW_FLOOR: "Below the floor price - management approval required",
  POLICY_MISSING: "No approved pricing policy, so this price cannot be judged",
});

const CONTRACT = Object.freeze({
  BAND_V1: "MARGIN_BAND_V1",
  FLOOR_V2: "MARKUP_FLOOR_V2",
});

/** Which contract a stored payload speaks. Absent reads as the retired band. */
function contractOf(margin = {}) {
  if (margin.pricingContract) return margin.pricingContract;
  return present(margin.floorMarkupPercent) ? CONTRACT.FLOOR_V2 : CONTRACT.BAND_V1;
}

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * The FLOOR a stored version carries, read without the database.
 *
 * Three outcomes, and the middle one is the one that matters:
 *   APPLIED      an approved V2 version with a markup. Prices.
 *   LEGACY_BAND  an approved V1 version. Real, historical, and unable to
 *                price a new costing -- its band is a margin, and reading a
 *                margin as a markup would change every price silently.
 *   POLICY_MISSING  nothing approved at all.
 */
function floorOf(policy = null) {
  const m = policy?.margin || {};
  if (!policy) {
    return {
      state: STATE.POLICY_MISSING,
      pricingContract: null,
      floorMarkupPercent: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: "The Board has not approved a pricing policy for this company, so there is no floor "
          + "price. A costing priced at a markup nobody decided is not a price.",
      }],
    };
  }
  if (contractOf(m) !== CONTRACT.FLOOR_V2 || !present(m.floorMarkupPercent)) {
    return {
      state: STATE.LEGACY_BAND,
      pricingContract: CONTRACT.BAND_V1,
      floorMarkupPercent: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        /* Deliberately NOT offered a conversion. 20% margin is 25% markup, and
           a system that helpfully did that arithmetic would reprice the whole
           company on an inference nobody approved. */
        message: "This company's approved pricing policy still states the retired three-band margin. "
          + "A floor price needs one management markup percentage, and an old margin is not one — "
          + "the Board states the markup deliberately.",
      }],
    };
  }
  return {
    state: STATE.APPLIED,
    pricingContract: CONTRACT.FLOOR_V2,
    floorMarkupPercent: m.floorMarkupPercent,
    missing: [],
  };
}

/**
 * One scenario's floor price, in minor units.
 *
 * ── EXACT DECIMAL, ROUNDED ONCE, THE WAY EVERY PRICE IS ─────────────────────
 * `cost x (1 + m/100)`, computed exactly and then raised to the company's
 * saleable increment — the same `ceilToIncrement` the retired band used, so a
 * floor lands on a price somebody can actually quote. Raised, never lowered:
 * rounding a floor DOWN would publish a floor below the one management set.
 */
function floorPriceMinorOn(unitCostMinor, floorMarkupPercent, { increment = 1 } = {}) {
  if (!present(unitCostMinor) || !present(floorMarkupPercent)) return null;
  const exact = new Decimal(unitCostMinor)
    .multipliedBy(new Decimal(100).plus(new Decimal(floorMarkupPercent)))
    .dividedBy(100);
  return ceilToIncrement(exact, increment);
}

/**
 * Where a proposed price stands against a floor.
 *
 * Equal to the floor is AT_OR_ABOVE: a floor is the lowest acceptable price,
 * not a price to beat. A missing floor is never "above" -- nothing has been
 * cleared.
 */
function standingFor(proposedPriceMinor, floorPriceMinor) {
  if (floorPriceMinor === null || floorPriceMinor === undefined) {
    return { standing: STANDING.POLICY_MISSING, standingLabel: STANDING_LABEL.POLICY_MISSING };
  }
  if (proposedPriceMinor === null || proposedPriceMinor === undefined) return null;
  return Number(proposedPriceMinor) >= Number(floorPriceMinor)
    ? { standing: STANDING.AT_OR_ABOVE_FLOOR, standingLabel: STANDING_LABEL.AT_OR_ABOVE_FLOOR }
    : { standing: STANDING.BELOW_FLOOR, standingLabel: STANDING_LABEL.BELOW_FLOOR };
}

/** The band a stored version carries, read without the database. */
function bandOf(policy = null) {
  const m = policy?.margin || {};
  const complete = ["minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent"]
    .every((f) => present(m[f]));
  if (!policy || !complete) {
    return {
      state: STATE.POLICY_MISSING,
      minimumMarginPercent: null,
      targetMarginPercent: null,
      preferredMarginPercent: null,
      approvalThresholdMarginPercent: null,
      estimatedIncomeTaxRatePercent: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        /* ── SAID AS A REFUSAL, BECAUSE IT IS ONE ──────────────────────
           Unlike every other Board policy in this lane, this one does not
           leave a gap in a costing that otherwise calculates. It stops the
           price. The message says so rather than implying somebody could
           carry on without it. */
        message: "The Board has not approved a margin band for this company, so there is no basis for "
          + "a selling price. A costing cannot be priced at a margin nobody has decided.",
      }],
    };
  }
  return {
    state: STATE.APPLIED,
    minimumMarginPercent: m.minimumMarginPercent,
    targetMarginPercent: m.targetMarginPercent,
    preferredMarginPercent: m.preferredMarginPercent,
    /* Optional, and null when unset rather than zero: a threshold of nil would
       be a rule that every price needs approval, and a tax rate of nil would
       be a claim that the company pays none. */
    approvalThresholdMarginPercent: present(m.approvalThresholdMarginPercent)
      ? m.approvalThresholdMarginPercent : null,
    estimatedIncomeTaxRatePercent: present(m.estimatedIncomeTaxRatePercent)
      ? m.estimatedIncomeTaxRatePercent : null,
    missing: [],
  };
}

/**
 * The band in force for this company on this costing's date.
 *
 * Against the costing's own date, never against now: a costing dated in March
 * is priced at March's band, and a policy approved since — even one backdated
 * — is simply not the version this query selects. That is what stops a Board
 * decision re-pricing a version frozen last quarter.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  /* The BAND is still read beside the floor, because a version approved under
     V1 is a real decision a reader may need to see. What it never does is
     price anything -- `overlayFor` fills the markup only from V2. */
  return { policy: policy || null, ...floorOf(policy), band: bandOf(policy) };
}

/**
 * The names the engine and the profit bridge read, filled from the decision.
 *
 * ── AND NOTHING AT ALL WHEN THERE IS NO DECISION ────────────────────────────
 * Not zeroes. `engine.js` will then refuse with `REQUIRED`, which is the
 * correct outcome and a far better one than pricing a garment at a margin
 * nobody chose. `assertMarginPolicy` below turns that into a refusal that
 * names the Board, so the person is sent somewhere rather than shown an engine
 * error about a field.
 */
function overlayFor(resolved) {
  if (resolved?.state !== STATE.APPLIED) {
    /* Nothing. Not a zero markup, and emphatically not the old band -- a
       costing must refuse rather than price itself at a figure nobody chose.
       The three retired names are filled as `undefined` so an engine or a
       snapshot reading them finds an absence, never a stale value. */
    return {
      floorMarkupPercent: undefined,
      minimumMarginPercent: undefined,
      targetMarginPercent: undefined,
      preferredMarginPercent: undefined,
      approvalThresholdMarginPercent: undefined,
      estimatedIncomeTaxRatePercent: undefined,
    };
  }
  return {
    floorMarkupPercent: resolved.floorMarkupPercent,
    /* The retired four are NOT filled, on purpose and by name. A new version
       carries a floor and nothing else, so no downstream reader can find a
       band on it and quietly price three tiers from one. */
    minimumMarginPercent: undefined,
    targetMarginPercent: undefined,
    preferredMarginPercent: undefined,
    approvalThresholdMarginPercent: undefined,
    estimatedIncomeTaxRatePercent: undefined,
  };
}

/**
 * What gets frozen onto the version.
 *
 * The band values themselves are already frozen in `policySnapshot` and are
 * what the engine used. What no version could say is which approved decision
 * they came from and who stands behind it — this is that half, and it carries
 * the band again so a reader has the decision and its identity in one place
 * rather than having to trust that two blocks agree.
 */
function freeze({ resolved, asOf = new Date() }) {
  const policy = resolved?.policy || null;
  const band = resolved?.band || {};
  return {
    state: resolved?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    rationale: policy?.rationale || "",

    /* ── WHAT PRICED THIS VERSION, SAID RATHER THAN INFERRED ──────────
       The contract, the figure and the formula. A version holding a price
       and a percentage but not the method could be re-read years later under
       either formula, and the two differ by real money. */
    pricingContract: CONTRACT.FLOOR_V2,
    floorMarkupPercent: resolved?.floorMarkupPercent ?? null,
    calculationMethod: "MARKUP_ON_TRUE_COST",

    /* ── AND THE RETIRED BAND, NULL ON EVERY NEW VERSION ──────────────
       Read from the policy's own record rather than dropped, so a company
       whose approved policy still carries its historical band has that
       visible on the decision — but a version priced by a markup freezes
       nulls here, because no band priced it. */
    minimumMarginPercent: band.minimumMarginPercent ?? null,
    targetMarginPercent: band.targetMarginPercent ?? null,
    preferredMarginPercent: band.preferredMarginPercent ?? null,
    /* ── RECORDED, AND SAID NOT TO BE ENFORCED ────────────────────────
       Nothing in this system consults a threshold. Freezing it without
       `approvalThresholdEnforced: false` beside it would let a reader years
       later assume a price below it had been through an approval that never
       existed. */
    approvalThresholdMarginPercent: band.approvalThresholdMarginPercent ?? null,
    approvalThresholdEnforced: false,
    estimatedIncomeTaxRatePercent: band.estimatedIncomeTaxRatePercent ?? null,
    asOf,
  };
}

/**
 * Refuse a costing that has no approved band, by name.
 *
 * ── WHY THIS EXISTS RATHER THAN LETTING THE ENGINE THROW ────────────────────
 * The engine's own refusal is `minimumMarginPercent is required` — true, and
 * useless to the person reading it, who cannot set that field anywhere any
 * more. This names the decision, the desk that owns it and the screen.
 */
function assertApproved(resolved, { fail }) {
  if (resolved?.state === STATE.APPLIED) return;

  /* ── TWO REASONS, AND THEY NEED DIFFERENT ACTIONS ─────────────────────
     "Nothing approved" and "approved, but under the retired band" send the
     Board to the same screen to do two different things, and a single
     message would leave a company that HAS a policy being told it has none. */
  const legacy = resolved?.state === STATE.LEGACY_BAND;
  throw fail(
    "MARGIN_POLICY_REQUIRED",
    legacy
      ? "This company's approved pricing policy still states the retired three-band margin, so there "
        + "is no floor price. The Board approves one management markup percentage; an old margin is "
        + "not one, and nothing converts it automatically."
      : "The Board has not approved a pricing policy for this company, so there is no floor price. "
        + "A costing priced at a markup nobody decided is not a price.",
    {
      reason: "MARGIN_POLICY_REQUIRED",
      ownedBy: "BOARD",
      policyKey: POLICY_KEY,
      pricingContract: legacy ? CONTRACT.BAND_V1 : null,
      needs: "floorMarkupPercent",
      owner: { ...OWNER.BOARD },
      settingsPath: "/board/dashboard/policies/margin",
    },
  );
}

/**
 * The legacy band, in the shape a Board draft takes.
 *
 * ── AND WHY IT IS OFFERED ───────────────────────────────────────────────────
 * Every company that has ever raised a costing has these three set — the old
 * schema made them required. Retyping a band that governs every price the
 * company quotes invites a transcription error into the one rule a costing
 * cannot be calculated without.
 *
 * The `"0"` DEFAULT is deliberately not offered as a seed. A company sitting on
 * the schema default has not chosen a nil floor; it has never opened the
 * screen. Seeding that would hand the Board a band to rubber-stamp that nobody
 * ever meant — which is the precise failure this whole migration is about.
 */
async function legacySeed(ctx) {
  /* Required lazily: `policy.service` requires this module, and requiring it
     back at load time would close the cycle before either had exports. */
  const policyService = require("./policy.service");
  const { policy, configured } = await policyService.getPolicy(ctx);
  const band = {
    minimumMarginPercent: policy?.legacyMinimumMarginPercent,
    targetMarginPercent: policy?.legacyTargetMarginPercent,
    preferredMarginPercent: policy?.legacyPreferredMarginPercent,
  };
  const allZero = Object.values(band).every((v) => present(v) && Number(v) === 0);
  if (!configured || !Object.values(band).every(present) || allZero) {
    return {
      source: "LEGACY_COSTING_POLICY",
      available: false,
      margin: null,
      historicalBand: null,
      suggestion: null,
      allZeroDefault: allZero,
    };
  }

  /* ── WHAT THE SAME PRICE WOULD BE AS A MARKUP ────────────────────────────
     A margin of m gives `cost / (1 - m)`; the markup that produces the SAME
     price is `m / (1 - m)` — so a 20% margin is a 25% markup, and a 25%
     margin is 33.33%.
     Offered as an UNSIGNED SUGGESTION and nothing more: it is not seeded into
     the draft, it is not a default, and the Board types the number it means.
     Presenting it as a value would let a company's entire pricing floor move
     on arithmetic nobody approved. */
  const suggestionFor = (marginPercent) => {
    const m = new Decimal(marginPercent);
    if (m.isGreaterThanOrEqualTo(100)) return null;
    return m.dividedBy(new Decimal(100).minus(m)).multipliedBy(100).decimalPlaces(4).toFixed();
  };

  return {
    source: "LEGACY_COSTING_POLICY",
    /* ── NOT "AVAILABLE" AS A SEED ANY MORE ───────────────────────────────
       There is nothing here a draft can be filled from: the band is not a
       markup, and the only field a new policy has is a markup. What IS
       available is the history, so the Board can see what the company used to
       do while deciding what it will do. */
    available: false,
    margin: null,
    historicalBand: { ...band },
    suggestion: {
      basis: "EQUIVALENT_MARKUP_FOR_THE_SAME_PRICE",
      /* Named so no screen can render it as a decision. */
      status: "UNAPPROVED_SUGGESTION",
      note: "Arithmetic only. The markup that would produce the same selling price as the retired "
        + "margin, offered so the Board can compare — not a recommendation, not a default, and not "
        + "applied until the Board states a markup itself.",
      fromMinimumMarginPercent: suggestionFor(band.minimumMarginPercent),
      fromTargetMarginPercent: suggestionFor(band.targetMarginPercent),
      fromPreferredMarginPercent: suggestionFor(band.preferredMarginPercent),
    },
    allZeroDefault: false,
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, CODES, STANDING, STANDING_LABEL, CONTRACT,
  contractOf, floorOf, floorPriceMinorOn, standingFor,
  bandOf, resolveFor, overlayFor, freeze, assertApproved, legacySeed,
};
