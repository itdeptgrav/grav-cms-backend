// models/CMS_Models/Board/BoardPolicy.js
//
// A COMPANY-WIDE DECISION THE BOARD MADE, ON A DATE, WITH A NAME AGAINST IT.
//
// ── WHY THIS IS NOT ANOTHER FIELD ON `CostingPolicy` ────────────────────────
// `CostingPolicy` is one mutable row per company. It is the right shape for a
// standing convention — the currency a company calculates in, the step it
// rounds prices to — and the wrong shape for a governed decision, for three
// reasons that only show up later:
//
//   · there is no draft. Whatever somebody types is in force the instant they
//     save it, so a rule cannot be prepared, reviewed, or approved;
//   · there is no history. `revision` counts changes and keeps none of them,
//     so "what was the financing rate in March" is answerable only by finding
//     a costing frozen in March and reading its snapshot;
//   · there is no effective date. A rate agreed in September for October
//     cannot be recorded until October, by somebody who has to remember.
//
// So a Board policy is a VERSION, not a field. Approving one never edits the
// one before it — it takes over from a date, and the earlier version stays on
// the record exactly as it was approved.
//
// ── WHY ONLY TWO STATUSES ARE STORED ────────────────────────────────────────
// The vocabulary a person reads is four: DRAFT → BOARD_APPROVED → EFFECTIVE →
// SUPERSEDED. Only the first two are ACTS. The other two are consequences of
// the calendar and of what has been approved since:
//
//   EFFECTIVE   an approved version whose date has arrived and which nothing
//               later has taken over.
//   SUPERSEDED  an approved version a later approved one now stands in front
//               of.
//
// Storing those would mean something has to run at midnight to make a
// future-dated policy true, and something has to write to every earlier row on
// every approval. Both are ways to get history wrong — a job that does not run
// leaves the company on last year's rate with no sign anything is amiss. They
// are DERIVED, in `services/board/boardPolicy.service.js`, from the two facts
// that are actually stored: whether it was approved, and from when.
//
// ── AND WHY A FROZEN COSTING IS SAFE FROM ALL OF IT ─────────────────────────
// It is not safe because of anything here. A `CostingVersion` copies the
// policy it used, and reads the copy for ever after. Publishing a new version,
// backdating one, or superseding one cannot restate a calculation that has
// already been made — see `financingProvenance` on CostingVersion.
"use strict";

const mongoose = require("mongoose");

const { BASIS_KEYS } = require("../../../services/centralCosting/engine");
const { decimalString } = require("../Costing/costingCalculation");

/**
 * Which company decision this version is a version OF.
 *
 * One key today. The lifecycle, the resolution rule and the screen are built
 * to carry the rest — overhead, labour methodology, the duty table, the margin
 * guardrails — but each of those is its own migration with its own contract,
 * and declaring keys nothing writes would suggest they were available.
 */
const POLICY_KEYS = Object.freeze([
  "FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY", "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY",
]);

/**
 * Which sub-document each key's methodology lives in.
 *
 * ── WHY A NAMED FIELD PER KEY AND NOT ONE `Mixed` PAYLOAD ───────────────────
 * A generic blob would make this file shorter and every policy weaker: nothing
 * would validate a rate, an enum could hold any string, and the completeness
 * check before approval would have to be written per key anyway — just
 * somewhere with no schema behind it. What is genuinely shared is the
 * LIFECYCLE (draft, approval, effective dating, supersession, isolation), and
 * that is shared. What each policy MEANS is not shared and is not forced to
 * look as though it is.
 */
const PAYLOAD_FIELD = Object.freeze({
  FINANCING: "financing",
  OVERHEAD: "overhead",
  LABOUR_METHODOLOGY: "labour",
  GST_TAX_POLICY: "gst",
  DEVELOPMENT_CHARGE_POLICY: "developmentCharges",
  CONTINGENCY_POLICY: "contingency",
  MARGIN_POLICY: "margin",
  DUTY_POLICY: "dutyRules",
});

/** The two states that are ACTS. See the header for why the other two are not. */
const STORED_STATUSES = Object.freeze(["DRAFT", "BOARD_APPROVED"]);

/** The whole vocabulary, as a reader sees it. */
const LIFECYCLE = Object.freeze(["DRAFT", "BOARD_APPROVED", "EFFECTIVE", "SUPERSEDED"]);

/**
 * How the Board treats the customer's advance.
 *
 * ── WHY THIS IS A QUESTION AND NOT AN ASSUMPTION ────────────────────────────
 * "Money the company has already been paid is not money it is financing" is
 * the common answer and it is not the only defensible one: a company financing
 * its whole working-capital cycle at a blended rate may deliberately charge
 * the full order. The two produce materially different garment costs on any
 * order with a substantial advance, so the code does not pick.
 */
const ADVANCE_TREATMENTS = Object.freeze(["REDUCES_FINANCED_AMOUNT", "IGNORED"]);

/**
 * Days in the year, for turning an annual rate into the rate for a period.
 *
 * 365 (actual) and 360 (commercial, 30/360) are both in ordinary use and
 * differ by about 1.4% of the financing figure. Controlled values rather than
 * a free number: 366, 300 or 12 would each be somebody having misunderstood
 * the question rather than having answered it differently.
 */
const DAY_COUNT_BASES = Object.freeze([365, 360]);

/**
 * WHEN THE COMPANY'S MONEY GOES OUT.
 *
 * Financing is what it costs to wait, and waiting has to start somewhere. The
 * company that commits to fabric in January and ships in March finances that
 * order for two months longer than the one that buys on the day it cuts, and
 * nothing in a rate, a basis or a day-count says which company this is.
 *
 * It was implicit before, and implicit is what this record exists to end: the
 * duration came from Sales' own anchor, so the Board's methodology silently
 * inherited whatever event a salesperson had picked for the balance. Now the
 * Board states it, in the operational events the order actually has.
 *
 * No default. An unstated start is an unanswered question and blocks
 * approval, exactly like an unstated rate.
 */
const FINANCING_START_EVENTS = Object.freeze([
  "MATERIAL_COMMITMENT",
  "PRODUCTION_START",
  "DISPATCH",
  "INVOICE",
]);

/**
 * THE FINANCING METHODOLOGY.
 *
 * Every field is required for an APPROVAL and none has a default. A partially
 * stated methodology is not a cheaper methodology — it is an unanswered
 * question, and a costing calculated from one would be presenting a guess with
 * the Board's name on it. A draft may hold any subset; approval is where the
 * contract is enforced.
 */
const financingMethodologySchema = new mongoose.Schema(
  {
    /* Per year, always. A rate whose period is implicit is the defect this
       whole record exists to end — see `dayCountBasis`, which says what a
       year means here. */
    annualRatePercent: decimalString({ default: undefined }),
    /* Which costing subtotal it is charged on. Reuses the engine's own basis
       vocabulary rather than a second one: a basis this record could name and
       the engine could not resolve would be a rule that never applies. */
    basis: { type: String, enum: BASIS_KEYS, default: undefined },
    advanceTreatment: { type: String, enum: ADVANCE_TREATMENTS, default: undefined },
    dayCountBasis: { type: Number, enum: DAY_COUNT_BASES, default: undefined },
    /* The operational event the company's money is out FROM. Every tranche's
       financed days is a calendar difference measured from this date to the
       date that tranche falls due — see
       `services/centralCosting/financing.service.js`. */
    startEvent: { type: String, enum: FINANCING_START_EVENTS, default: undefined },
  },
  { _id: false },
);

/**
 * THE OVERHEAD METHODOLOGY.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not split company overhead from factory overhead. The rule this
 * replaces was one rate called "Company and factory overhead", every costing
 * ever frozen carries that single figure, and nothing in this repository
 * records the two pools separately — so splitting them here would mean
 * inventing an allocation nobody has computed and then asking the Board to
 * approve it. The combined meaning is preserved exactly; separating them is a
 * costing decision with its own evidence, not a side effect of governing the
 * rate.
 *
 * Both fields are required for an APPROVAL and neither has a default. A rate
 * with no basis is not a rule — it is a percentage of something unstated — and
 * a basis with no rate applies nothing. That both-or-neither rule is the one
 * `CostingPolicy` already enforced; what is new is that somebody has to
 * approve the pair and say when it starts.
 */
const overheadMethodologySchema = new mongoose.Schema(
  {
    /* What proportion of the chosen subtotal the company adds to cover what it
       costs to run. Up to 1000%, as the legacy rule allowed: a real overhead
       pool on a narrow basis can exceed 100%, and refusing it would be
       inventing a business rule the company never asked for. */
    ratePercent: decimalString({ default: undefined }),
    /* Which subtotal it is charged on. The engine's own basis vocabulary, so a
       basis this record can name is one the engine can resolve. */
    basis: { type: String, enum: BASIS_KEYS, default: undefined },
  },
  { _id: false },
);

/**
 * Where machine cost sits.
 *
 * Three real answers, and — unlike financing's two — they are not equally
 * calculable today. That difference is the whole reason this enum stays an
 * enum rather than becoming a boolean:
 *
 *   IN_OPERATION_RATE  says machine cost is inside the labour rate. Nothing
 *                      in this repository records a machine hourly cost, a
 *                      depreciation schedule or a power rate, so choosing it
 *                      states an INTENTION and supplies no number. The Board
 *                      may approve it; costing then reports the missing
 *                      source, and the fix is a Production master rather than
 *                      a policy edit.
 *   IN_OVERHEAD        is answered — by the Board's own overhead policy, which
 *                      carries a rate. It therefore DEPENDS on that policy
 *                      being in force, and costing says so when it is not.
 *   NOT_COSTED         is a deliberate exclusion. An answer, recorded, with
 *                      the rationale the version already carries.
 */
const MACHINE_BURDEN_TREATMENTS = Object.freeze([
  "IN_OPERATION_RATE", "IN_OVERHEAD", "NOT_COSTED",
]);

/**
 * THE LABOUR-COSTING METHODOLOGY.
 *
 * ── WHAT THE BOARD DECIDES, AND WHAT PRODUCTION DOES ────────────────────────
 * Production owns the route, the SAM and which salary basis an operation is
 * paid at. None of that is here. What is here is how a paid month becomes a
 * PRODUCTIVE month, what an operator costs beyond take-home pay, and where
 * machine cost is accounted for — three company-wide assumptions that decide
 * what every minute of every operation costs.
 *
 * ── THE PRODUCTIVE BASIS IS ONE ANSWER, NOT TWO ─────────────────────────────
 * `productiveMinutesPerMonth` and `labourEfficiencyPercent` are two ways of
 * saying the same thing, and a company that states both has said two different
 * numbers — 9,000 minutes and 80% of 12,480 is 9,984. Silently preferring
 * either buries a disagreement inside every labour rate the company quotes, so
 * both-at-once is refused at the write and neither-at-all is refused at
 * approval. `labourCost.productiveBasis()` has always enforced this; the
 * schema cannot see sibling fields reliably, so the rule lives in the service.
 */
const labourMethodologySchema = new mongoose.Schema(
  {
    /* The denominator the rate is divided by, stated directly. */
    productiveMinutesPerMonth: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "Productive minutes per month is a positive number.",
      },
    },
    /* Or the same answer as a fraction of the paid month. Exactly one. */
    labourEfficiencyPercent: decimalString({ default: undefined }),
    /* PF, ESI, gratuity, bonus — on top of net salary. Zero is a decision a
       company may genuinely make; absent is not zero, and the calculation
       refuses rather than treating take-home pay as an operator's cost. */
    employerBurdenPercent: decimalString({ default: undefined }),
    machineBurdenTreatment: {
      type: String, enum: MACHINE_BURDEN_TREATMENTS, default: undefined,
    },
    /* ── WHY `NOT_COSTED` CARRIES ITS OWN REASON ──────────────────────
       The other two treatments point at somewhere the cost IS accounted for.
       This one says it is not accounted for anywhere, which is a deliberate
       exclusion and the kind of decision an auditor asks about. The version's
       `rationale` covers the policy as a whole; this is the sentence about
       the exclusion specifically. */
    machineExclusionReason: { type: String, trim: true, default: "", maxlength: 1000 },
  },
  { _id: false },
);

/**
 * Whether eligible input GST is reclaimed or becomes product cost.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not the GST RATE — that is the supplier's, recorded on their quotation, and
 * it varies by what is being bought. Not customs DUTY, which is a different
 * charge on a different event with no source in this system yet. Not OUTPUT
 * GST, which is charged to the customer on a Sales invoice. Four different
 * facts that are routinely spoken about as "GST", and only this one is a
 * company-wide decision.
 *
 * ── AND IT DOES NOT OVERRIDE THE LAW ────────────────────────────────────────
 * The Board is stating how the company treats input tax it is ELIGIBLE to
 * reclaim. Where a supply is not taxable at all, the quotation says so and
 * that wins — see `offerPricing.taxPositionFor`, which refuses a company
 * treatment on a `NON_TAXABLE` quotation rather than applying one.
 */
const GST_TREATMENTS = Object.freeze(["RECOVERABLE", "NON_RECOVERABLE"]);

/**
 * THE INPUT GST TREATMENT.
 *
 * One field, and no default. It is the difference between the tax being
 * garment cost and not being garment cost, on every purchased line — so
 * assuming recoverable under-costs every non-recoverable purchase and
 * assuming the reverse over-costs the rest. Until the Board states it, the
 * calculation refuses rather than guessing either way.
 */
const gstMethodologySchema = new mongoose.Schema(
  {
    inputGstTreatment: { type: String, enum: GST_TREATMENTS, default: undefined },
  },
  { _id: false },
);

/**
 * WHETHER THE COMPANY ADDS A STANDARD CONTINGENCY, AND ON WHAT.
 *
 * ── THE DECISION IS A MODE, NOT A RATE ──────────────────────────────────────
 * Every other policy here answers "how much". This one answers "do we at all",
 * and only then "how much" — because the two ways of having no contingency are
 * completely different facts:
 *
 *   NONE   the Board considered it and decided the company does not add one.
 *          An audited decision, with a name and a date against it.
 *   (no policy at all)
 *          nobody has decided. Not the same thing, and the costing must not
 *          read it as though the Board had chosen NONE.
 *
 * Collapsing those two is exactly the defect this migration exists to close:
 * under the retired writer an absent rate silently produced no line, so "we
 * decided not to" and "nobody has looked at this" were the same record.
 *
 * ── AND WHY `APPLY` WITH A 0% RATE IS STILL A THIRD THING ───────────────────
 * The engine already tells them apart and this preserves it: an explicit 0%
 * produces a real MISC line of zero on a stated basis, and NONE produces no
 * line. Both are decisions; they are not the same decision. "We add a
 * contingency, currently set at nil" leaves a line in every build-up that a
 * later Board can raise without changing the shape of the cost sheet; "we do
 * not add one" says the company does not work that way at all.
 */
const CONTINGENCY_MODES = Object.freeze(["APPLY", "NONE"]);

const contingencyMethodologySchema = new mongoose.Schema(
  {
    /* `APPLY` or `NONE`. Never defaulted — that is the whole point. */
    mode: { type: String, enum: CONTINGENCY_MODES, default: undefined },
    /* Both meaningful only under APPLY, and validated as a pair: a rate with
       no basis is a percentage of nothing, and a basis with no rate is a
       subtotal nobody is charging against. */
    ratePercent: decimalString({ default: undefined }),
    basis: { type: String, enum: BASIS_KEYS, default: undefined },
  },
  { _id: false },
);

/**
 * WHAT THE COMPANY IS PREPARED TO SELL FOR.
 *
 * ── THE ONE POLICY THE ENGINE CANNOT CALCULATE WITHOUT ──────────────────────
 * Every other Board policy in this lane is a cost the engine adds or does not
 * add. This one is different: `engine.js` reads all three band figures as
 * REQUIRED, refuses `undefined` outright, and enforces the ordering itself. A
 * costing with no margin band is not a costing with a gap in it — it is not a
 * costing at all, because there is no price to solve for.
 *
 * That is why `CostingPolicy` defaulted these to "0" and leaned on a separate
 * `configured` flag to tell an unconfigured company from a deliberate one. The
 * flag worked; what it could not carry is WHO decided, and from when.
 *
 * ── MARGINS, NEVER MARKUP ───────────────────────────────────────────────────
 *     selling price = cost / (1 - margin)
 * A 25% margin is a 33.3% markup, and a band interpreted the wrong way passes
 * prices the company forbids. Stated here because this sub-document is where
 * somebody reading the stored data meets the numbers.
 *
 * ── AND THE THREE ARE ONE DECISION ──────────────────────────────────────────
 * `0 ≤ minimum ≤ target ≤ preferred < 100`, validated as a unit. A floor above
 * the target is not a stricter policy; it is an incoherent one, and the engine
 * already refuses it with `MARGIN_BAND_OUT_OF_ORDER`.
 */
const marginPolicySchema = new mongoose.Schema(
  {
    /* ── WHICH PRICING CONTRACT THIS VERSION SPEAKS ───────────────────────
       The lineage is one policy and stays one policy: `MARGIN_POLICY` is the
       identity every frozen version names, the key the effective-date
       supersession index is built on, and the thing a company's approval
       history hangs off. Starting a second key would have made every approved
       band read as never approved, and would have let two pricing policies be
       in force for one company on one date — the exact thing this lineage
       exists to prevent.

       So the CONTRACT is versioned instead of the key:

         MARGIN_BAND_V1   the retired three-band model. Historical only. No
                          new version may be approved under it.
         MARKUP_FLOOR_V2  one management markup, one floor price.

       Absent on every version approved before this field existed, which is
       read as V1 — they were all bands, and inferring that from their own
       contents would be guessing at something they can simply be asked. */
    pricingContract: {
      type: String,
      enum: ["MARGIN_BAND_V1", "MARKUP_FLOOR_V2"],
      default: undefined,
    },

    /* ── V2: THE ONE FIGURE MANAGEMENT SETS ───────────────────────────────
       A MARKUP on the true unit cost, not a margin on the selling price. The
       two are different arithmetic and the difference is money:

         markup 20% on ₹500  →  500 × 1.20        = ₹600
         margin 20% on ₹500  →  500 ÷ (1 − 0.20)  = ₹625

       Nothing converts one to the other automatically. A company's old 20%
       margin is not a 20% markup, and quietly re-reading it as one would
       change every floor price in the company without anybody deciding to.

       `0` is a legitimate approved decision — sell at cost — and is not the
       same as unset, which blocks. */
    floorMarkupPercent: decimalString({ default: undefined }),

    /* ── V1, RETIRED AS INPUTS AND KEPT AS RECORD ─────────────────────────
       No new version may set these. They stay in the schema because versions
       approved under them are still read, still explain prices that were
       quoted, and must keep showing exactly what they froze. */
    /* The commercial floor: below this the company would rather not sell. */
    minimumMarginPercent: decimalString({ default: undefined }),
    /* The normal acceptable return. */
    targetMarginPercent: decimalString({ default: undefined }),
    /* The recommended opening position. */
    preferredMarginPercent: decimalString({ default: undefined }),

    /* ── RECORDED, HONESTLY NOT ENFORCED, AND NOW ALSO RETIRED ────────────
       Retired as an INPUT with the band it belonged to: it was a threshold
       expressed in margin, and there is no margin any more. Under the floor
       contract the equivalent question — "which prices need a second
       signature?" — has a different and simpler answer: any price below the
       floor. That standing is published; the workflow that acts on it is not
       built here.

       A margin below which a price ought to need somebody's approval. Nothing
       in this system reads it — there is no costing approval workflow that
       consults a threshold, and building one is not this policy's business.

       Kept OPTIONAL and migrated as a recorded intent rather than dropped:
       companies have set it, it is a real statement of where they want a
       second signature, and deleting it would lose that. What must not happen
       is a screen implying it stops anything. */
    approvalThresholdMarginPercent: decimalString({ default: undefined }),

    /* ── AN AFTER-TAX PROFIT ESTIMATE — NOT GST, NOT COST, AND NOT PRICING ─
       Also not an input to the floor. It never was part of the price
       arithmetic and it is not part of this one either: the floor is a cost
       plus a markup, and income tax is a management-reporting assumption
       about profit AFTER a price is agreed. Preserved on historical versions
       and no longer accepted on a new one — see the pricing decision record.
       Used by `profitBridge` to turn a pre-tax profit figure into an after-tax
       one. It never touches the price arithmetic and never enters the cost
       build-up: a costing calculates identically whether or not it is set, and
       only the profit COMMENTARY changes.

       It sits on this policy rather than one of its own because it is a profit
       assumption, read beside the band by the same people for the same
       purpose. It is emphatically not the input GST treatment — that is
       `GST_TAX_POLICY`, it is about tax on purchases, and it does change what
       a garment costs. */
    estimatedIncomeTaxRatePercent: decimalString({ default: undefined }),
  },
  { _id: false },
);

/**
 * WHAT THE COMPANY PAYS TO BRING IMPORTED GOODS IN.
 *
 * ── THE THREE FACTS, AND WHO OWNS EACH ──────────────────────────────────────
 * Customs duty needs three things, and no one desk holds them:
 *
 *   Store   whether these goods are IMPORTED and where they came from —
 *           recorded on the supplier's quotation, because the same fabric may
 *           be quoted by a local mill and by an importer.
 *   Item    the customs tariff classification, on `RawItem.customsTariffCode`,
 *           because a heading belongs to the goods and not to one offer.
 *   Board   what rate that heading and origin attract — this table.
 *
 * A costing that is missing any one of them is blocked naming the desk that
 * holds it. None of the three is ever inferred from the others.
 *
 * ── AND WHAT IS DELIBERATELY NOT INFERRED ───────────────────────────────────
 *   · the HSN on a quotation is a GST classification, not a customs heading;
 *   · a supplier's address is where the supplier is, not where goods were made;
 *   · an item's category says nothing about its tariff heading.
 * Each of those would turn a missing fact into a confident wrong number.
 *
 * ── EXACT MATCHING, FOR THIS FIRST VERSION ──────────────────────────────────
 * A rule matches when the tariff code and the ISO-2 origin BOTH equal the
 * line's. No prefix matching on headings, no "rest of world" fallback, no
 * preferential-origin logic. Every one of those is a real customs concept and
 * every one needs evidence this system does not record; adding them as
 * matching rules would let the table answer questions the data cannot.
 */
const dutyRuleSchema = new mongoose.Schema(
  {
    /* Permanent, minted once. A frozen costing names it in provenance, so it
       can be deactivated but never removed or reused. */
    key: { type: String, required: true, trim: true, maxlength: 60 },
    /* The customs heading, as the item master states it. Uppercased on both
       sides so "6204.42" and "6204.42" are one heading and not two. */
    customsTariffCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    /* ISO-2, matching `SupplierOffer.sourcing.countryOfOrigin`. */
    countryOfOrigin: { type: String, required: true, trim: true, uppercase: true, maxlength: 2 },
    /* ── A RATE OF ZERO IS A RULE, NOT AN ABSENCE ──────────────────────
       "This heading from this origin attracts no duty" is a decision somebody
       checked and approved. It produces a recorded nil result, which is a
       different record from no rule at all. */
    ratePercent: decimalString({ required: true }),
    /* Half-open `[from, to)`, like every other dated period in this domain, so
       a period ending on the 1st and one starting on the 1st do not overlap. */
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: undefined },
    active: { type: Boolean, default: true },
    /* What a person calls it. Carries no arithmetic. */
    label: { type: String, trim: true, maxlength: 200, default: "" },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false },
);

/** How a development charge scales. The vocabulary `developmentCharges.js` reads. */
const DEVELOPMENT_CALCULATIONS = Object.freeze(["FLAT_PER_RUN", "PER_REQUIREMENT_UNIT"]);

/**
 * THE COMPANY'S OWN DEVELOPMENT AND TOOLING CHARGE CATALOGUE.
 *
 * ── THE FIRST POLICY THAT IS A TABLE ────────────────────────────────────────
 * The other four are a rate, a rate and a basis, three assumptions, and an
 * enum. This is a list of named charges, each with its own history of rates.
 * That is not a shape a percentage can express: pattern development is ₹10,000
 * for the run and screen making is ₹2,000 A SCREEN, and a garment needing four
 * is ₹8,000 — once.
 *
 * ── AND THE FIRST WITH TWO LAYERS OF DATING ─────────────────────────────────
 * The Board VERSION's `effectiveFrom` says which catalogue is company policy
 * on a costing's date. Each charge's own `rates[]` periods say which rate
 * inside that catalogue applies on the same date. Both are load-bearing and
 * neither replaces the other:
 *
 *   · without the outer layer, adding a charge would silently apply to every
 *     costing ever recalculated;
 *   · without the inner one, publishing October's rate would re-price a
 *     costing already approved at September's — which is the exact defect
 *     `rates[]` was introduced to fix.
 *
 * ── THE KEY IS PERMANENT ────────────────────────────────────────────────────
 * Live Merchandising requirements hold it and frozen versions name it, so a
 * key that disappears takes the meaning of both with it. Withdrawal is
 * `active: false`; the row stays readable for ever.
 */
const developmentChargeSchema = new mongoose.Schema(
  {
    /* Permanent. The label may be edited; this is what a stored requirement
       and a frozen version point at. */
    key: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: "", maxlength: 1000 },
    calculation: {
      type: String, enum: DEVELOPMENT_CALCULATIONS, default: "FLAT_PER_RUN",
    },
    /* What one of it IS — Screen, Plate. Only a per-unit charge has one; on a
       flat charge it would name a quantity nobody enters. */
    unit: { type: String, trim: true, maxlength: 60, default: undefined },
    /* Inactivation replaces deletion. A charge named on last quarter's
       costing stays readable for ever. */
    active: { type: Boolean, default: true },

    /* ── THE RATE, OVER TIME ──────────────────────────────────────────
       Half-open `[effectiveFrom, effectiveTo)`, so a period ending on the 1st
       and one beginning on the 1st do not both apply to a costing dated the
       1st. Non-overlap is enforced in the service, where sibling periods can
       be compared. */
    rates: {
      type: [new mongoose.Schema({
        /* Integer minor units. No floating-point money. */
        amountMinor: {
          type: Number,
          required: true,
          validate: {
            validator: (v) => Number.isSafeInteger(v) && v >= 0,
            message: "A development charge is a whole number of minor units, not negative.",
          },
        },
        /* The company's base currency, always: nothing here holds an exchange
           rate on a date, so another currency could only be converted by
           guessing. */
        currency: { type: String, trim: true, default: "INR" },
        effectiveFrom: { type: Date, required: true },
        effectiveTo: { type: Date, default: undefined },
      }, { _id: false })],
      default: undefined,
    },
  },
  { _id: false },
);

const boardPolicySchema = new mongoose.Schema(
  {
    /* From the actor's proven membership, never from a body. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    policyKey: { type: String, required: true, enum: POLICY_KEYS, index: true },

    status: { type: String, required: true, enum: STORED_STATUSES, default: "DRAFT" },

    /* ── FROM WHEN ────────────────────────────────────────────────────────
       Required on approval, not on a draft: a rule being prepared may not yet
       have a date agreed, and demanding one would make people type a
       placeholder that later reads as a decision.

       Stored as a Date and compared as one. A version whose date has not
       arrived is BOARD_APPROVED and applies to nothing — which is the whole
       point of being able to approve one in advance. */
    effectiveFrom: { type: Date, default: undefined },

    /* ── ONE SUB-DOCUMENT PER POLICY KEY ──────────────────────────────────
       Only the one named by `policyKey` is ever written; the others stay
       absent. Declared rather than carried by `strict: false`, like everything
       else in this domain: a field nobody declared is a field nobody can rely
       on, and a methodology nobody can validate is a methodology nobody can
       approve. */
    financing: { type: financingMethodologySchema, default: () => ({}) },
    overhead: { type: overheadMethodologySchema, default: () => ({}) },
    labour: { type: labourMethodologySchema, default: () => ({}) },
    gst: { type: gstMethodologySchema, default: () => ({}) },
    contingency: { type: contingencyMethodologySchema, default: () => ({}) },
    margin: { type: marginPolicySchema, default: () => ({}) },
    /* A LIST, like the development charge catalogue and for the same reason:
       `default: undefined` rather than `[]`, because a company that has
       approved no rule has none, and an empty array on every version would be
       a table nobody wrote. */
    dutyRules: { type: [dutyRuleSchema], default: undefined },
    /* A LIST, unlike the other four payloads. `default: undefined` rather than
       `[]`: a company that has configured none has none, and an empty array on
       every version would be a table nobody wrote. */
    developmentCharges: { type: [developmentChargeSchema], default: undefined },

    /* ── WHY, IN WORDS ────────────────────────────────────────────────────
       The figure says what; this says on what basis. A rate with no rationale
       is unarguable a year later, and the person who has to defend it to an
       auditor is rarely the person who set it. */
    rationale: { type: String, trim: true, default: "", maxlength: 4000 },

    /* ── WHERE A DRAFT'S CONTENT CAME FROM ────────────────────────────────
       A draft prepared from the retired costing-policy table, or from the
       version currently in force, is a CONVENIENCE and not an approval. The
       Board still reviews it. Recorded so a later reader can tell a
       hand-written policy from a copied one — and so "we approved what was
       already there" is a visible statement rather than an assumption. */
    seededFrom: {
      type: String,
      enum: ["LEGACY_COSTING_POLICY", "EFFECTIVE_VERSION"],
      default: undefined,
    },

    /* ── WHO DECIDED, AND WHEN ────────────────────────────────────────────
       Stamped by the server at approval from the authenticated actor, never
       accepted from a body. Present exactly when `status` is BOARD_APPROVED. */
    approvedAt: { type: Date, default: undefined },
    approvedByActorId: { type: String, trim: true, default: "" },
    approvedByActorName: { type: String, trim: true, default: "" },

    createdByActorId: { type: String, trim: true, default: "" },
    createdByActorName: { type: String, trim: true, default: "" },
    updatedByActorId: { type: String, trim: true, default: "" },
    updatedByActorName: { type: String, trim: true, default: "" },

    /* Optimistic concurrency on a DRAFT, exactly as `CostingPolicy.revision`
       does it: a save composed against a stale read is refused rather than
       being allowed to put somebody else's change back. An approved version
       never moves, so this stops counting once it is approved. */
    revision: { type: Number, default: 1, min: 1 },
  },
  { timestamps: true, collection: "board_policies" },
);

/* ── AT MOST ONE POLICY EFFECTIVE FOR A COMPANY ON A DATE ──────────────────
   Enforced as: no two APPROVED versions of the same policy share an effective
   date. Resolution then takes the latest date at or before the costing's own,
   which yields exactly one — so "no overlapping effective versions" is a
   property of the data rather than a check somebody has to remember to run.

   Partial, so drafts are exempt: several drafts may name the same intended
   date while they are being argued about, and only one of them will be
   approved. */
boardPolicySchema.index(
  { companyId: 1, policyKey: 1, effectiveFrom: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "BOARD_APPROVED", effectiveFrom: { $type: "date" } },
  },
);

/* The resolution query: this company, this policy, approved, dated at or
   before the costing. Descending so the newest qualifying version is first. */
boardPolicySchema.index({ companyId: 1, policyKey: 1, status: 1, effectiveFrom: -1 });

const BoardPolicy =
  mongoose.models.BoardPolicy || mongoose.model("BoardPolicy", boardPolicySchema, "board_policies");

module.exports = BoardPolicy;
module.exports.POLICY_KEYS = POLICY_KEYS;
module.exports.PAYLOAD_FIELD = PAYLOAD_FIELD;
module.exports.MACHINE_BURDEN_TREATMENTS = MACHINE_BURDEN_TREATMENTS;
module.exports.GST_TREATMENTS = GST_TREATMENTS;
module.exports.DEVELOPMENT_CALCULATIONS = DEVELOPMENT_CALCULATIONS;
module.exports.STORED_STATUSES = STORED_STATUSES;
module.exports.LIFECYCLE = LIFECYCLE;
module.exports.ADVANCE_TREATMENTS = ADVANCE_TREATMENTS;
module.exports.FINANCING_START_EVENTS = FINANCING_START_EVENTS;
module.exports.DAY_COUNT_BASES = DAY_COUNT_BASES;
module.exports.CONTINGENCY_MODES = CONTINGENCY_MODES;
