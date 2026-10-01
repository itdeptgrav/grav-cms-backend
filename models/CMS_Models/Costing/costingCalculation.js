// models/CMS_Models/Costing/costingCalculation.js
//
// Central Costing — Chunk 2. WHAT A CALCULATED VERSION STORES.
//
// ── EVERYTHING NEEDED TO RE-DERIVE THE NUMBER, AND NOTHING LIVE ─────────────
// A frozen version has to answer, years later, "how was this number reached?"
// — which means it stores the INPUTS, the POLICY that was in force, and the
// RESULTS, all three, and none of them as a reference to something that can
// change. A `ref` to the company policy would show today's overhead rate
// against last spring's cost, which is the failure the whole versioning
// contract exists to prevent.
//
// ── MONEY IS INTEGER MINOR UNITS; RATES ARE DECIMAL STRINGS ─────────────────
// Percentages and consumptions are not integers (0.42 metres, 12.5% overhead)
// and storing them as doubles would reintroduce exactly the drift the engine
// avoids. They are stored as STRINGS and parsed with BigNumber, so the value
// that was typed is the value that is re-read. Money stays integer minor
// units, everywhere, as Chunk 1 established.
"use strict";

const mongoose = require("mongoose");

const { SUPPORTED_CURRENCIES } = require("../../../services/centralCosting/money");
const {
  CATEGORIES, BEHAVIOURS, BASIS_KEYS, TAX_TREATMENTS, EOS_CAUSES,
} = require("../../../services/centralCosting/engine");
const { ROUNDING_MODE_KEYS } = require("../../../services/centralCosting/decimal");

/** A decimal held as text. Validated for shape here; parsed by the engine. */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const decimalString = (extra = {}) => ({
  type: String,
  trim: true,
  validate: {
    validator: (v) => v === undefined || v === null || DECIMAL_PATTERN.test(v),
    message: (props) => `${props.path} must be a plain decimal number, written as text (got "${props.value}").`,
  },
  ...extra,
});

/* ── ONE MONEY CONTRACT, FOR EVERY WRITER ───────────────────────────────────
 * `services/centralCosting/calculationInput.js` refuses malformed money coming
 * in over HTTP. That is the right place for it and it is not enough: the
 * engine's own output, Chunk 2's legacy import, Chunk 3's supplier snapshots
 * and any future background job all write these documents WITHOUT passing
 * through a request parser. A `Number` path with no validator accepts 412.5
 * paise, `Infinity`, and integers past 2^53 where addition silently stops
 * being exact — and a costing that cannot be summed is not a costing.
 *
 * So every persisted `*Minor` field is declared through this helper.
 *
 * ── IT VALIDATES, IT DOES NOT REPAIR ───────────────────────────────────────
 * No setter, deliberately. A setter that rounded 412.5 to 413 would turn a
 * caller's bug into a silently wrong number that nobody could later find; the
 * write is refused instead, and the writer is told which field and what value.
 *
 * ── AND MISSING IS STILL NOT ZERO ──────────────────────────────────────────
 * `required: false` fields have NO default. An absent unit cost means "not
 * calculated", which is a different statement from "costs nothing", and
 * defaulting it to 0 is exactly the conflation this domain must not make.
 */
function minorUnits({ required = false, allowNegative = true, label } = {}) {
  return {
    type: Number,
    ...(required ? { required: true } : { default: undefined }),
    validate: {
      validator(v) {
        if (v === undefined || v === null) return !required;
        if (!Number.isSafeInteger(v)) return false;
        return allowNegative || v >= 0;
      },
      message: (props) =>
        `${label || props.path} must be a whole, exactly-representable number of minor units` +
        `${allowNegative ? "" : " and cannot be negative"} (got ${props.value}).`,
    },
  };
}

const moneySchema = new mongoose.Schema(
  {
    /* Negative is allowed: a credit, a rebate and a correction are all real
       amounts, and refusing them here would push somebody into storing a sign
       somewhere else. `services/centralCosting/money.js` takes the same view. */
    amountMinor: minorUnits({ required: true, label: "amountMinor" }),
    currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
  },
  { _id: false },
);

/* ── ONE COST INPUT ─────────────────────────────────────────────────────────
 * Deliberately GENERIC. Chunk 4 connects the BOM, consumption, SAM and
 * operation masters; modelling a garment bill of materials now, to replace it
 * two chunks later, would be building it twice and migrating it once for
 * nothing. A `MATERIAL` line here is whatever the person costing calls a
 * material, and it carries enough provenance for Chunk 3 to attach a real
 * supplier offer to it without the shape changing. */
const costLineSchema = new mongoose.Schema(
  {
    /* Stable within a version, and carried forward when a later version is
       derived from this one — so "what happened to the lining cost between
       version 2 and version 5" is answerable. */
    lineKey: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, required: true, enum: CATEGORIES },
    label: { type: String, trim: true, maxlength: 300, default: "" },
    behaviour: { type: String, required: true, enum: BEHAVIOURS },

    /* PER_UNIT: a rate and how much of it each piece consumes. Held as two
       fields rather than one per-unit total because "₹412.50 per metre ×
       1.4 m" is what a reviewer asks about, and a single collapsed figure
       cannot answer it. */
    unitRate: { type: moneySchema, default: undefined },
    quantityPerUnit: decimalString({ default: undefined }),
    quantityUom: { type: String, trim: true, maxlength: 32, default: "" },

    /* FIXED_PER_RUN: the same money however many pieces are made. */
    amount: { type: moneySchema, default: undefined },

    /* ── PER_CARTON: A RUN TOTAL THAT STEPS ───────────────────────────────
       A carton line is neither of the two above. It does not scale smoothly
       like a per-piece rate and it is not the same money at every run size
       like a fixed charge: 500 garments at 25 to a carton buy twenty cartons
       and 600 buy twenty-four. So each scenario's own total is frozen.

       Undeclared, these were silently dropped on save by `strict: true` — the
       version stored a carton line with no per-scenario totals at all, and an
       auditor asking what each run size was charged had nothing to read.

       `Mixed` because the keys are whatever scenario keys the version used,
       and freezing a shape here would date faster than the data. */
    amountByScenario: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /* How many garments a carton held WHEN THIS WAS CALCULATED. The count
       lives on the style's shipment record and may be corrected there; what
       this version was worked out with may not. */
    garmentsPerCarton: { type: Number, default: undefined },

    /* PERCENT_OF_BASIS: a rate and what it is a rate OF. */
    percent: decimalString({ default: undefined }),
    basis: { type: String, enum: BASIS_KEYS, default: undefined },

    /* ── TAX ──────────────────────────────────────────────────────────────
       Recoverable GST is NOT cost — the company gets it back. It is recorded
       so a buyer-facing figure can still show what has to be funded, and it
       is excluded from every cost total. Non-recoverable tax IS cost. */
    tax: {
      treatment: { type: String, enum: TAX_TREATMENTS, default: "NONE" },
      ratePercent: decimalString({ default: undefined }),
    },

    /* Where this figure came from and how much it can be trusted. Chunk 3
       replaces the manual case with a real supplier offer; the shape does not
       change, only what fills it. */
    /* ── A THIRD STATE, EARNED RATHER THAN CLAIMED (Chunk 3.2) ──────────
       `SUPPLIER_QUOTATION` is not settable by a client — the parser refuses
       any client-supplied confidence but PROVISIONAL. It is applied by the
       server when it has itself read a dated, referenced quotation from the
       Store register and derived the rate. Without it, a quotation-backed
       line would read exactly like a typed guess, which is the distinction
       this chunk exists to draw. */
    confidence: { type: String, enum: ["PROVISIONAL", "VERIFIED", "SUPPLIER_QUOTATION"], default: "PROVISIONAL" },
    sourceRefKey: { type: String, trim: true, maxlength: 200, default: "" },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false },
);

/* ── THE POLICY, FROZEN ─────────────────────────────────────────────────────
 * A copy, not a reference. When finance raises the target margin in October,
 * every costing approved in June must still read as it did in June — that is
 * roadmap decision 8, and a `ref` would break it silently. `revision` and
 * `capturedAt` say exactly which policy this was. */
/* ── WHAT SOMEBODY PROPOSED TO SELL IT FOR, AND WHAT THAT LEAVES ───────────
 * Deliberately its own block, beside the cost rather than inside it. A reader
 * must be able to tell at a glance which figures are what the product is
 * estimated to COST and which are what somebody proposed to SELL it for —
 * and changing a proposed price must be unable to move a cost line, which is
 * only credible if the two are stored apart.
 *
 * Every figure here is an ESTIMATE resting on two assumptions: that the cost
 * build-up is complete, and that the company's estimated effective income-tax
 * rate is about right. Neither is a fact about this order. */
const bridgeRowSchema = new mongoose.Schema(
  {
    scenarioKey: { type: String, required: true, trim: true, maxlength: 64 },
    /* EXCLUDING GST. Tax collected from a customer is not revenue — it is
       collected on the government's behalf and paid over. */
    proposedPriceExclTaxMinor: minorUnits({ required: true }),
    /* Price x quantity, excluding GST — what the run would invoice. */
    proposedRevenueTotalMinor: minorUnits({ default: undefined }),
    unitCostMinor: minorUnits({ required: true }),
    totalCostMinor: minorUnits({ required: true }),
    /* Signed: a proposed price below cost is a real answer, and refusing to
       store it would leave the screen unable to show a loss. */
    preTaxProfitUnitMinor: minorUnits({ required: true, allowNegative: true }),
    preTaxProfitTotalMinor: minorUnits({ required: true, allowNegative: true }),
    /* Profit as a share of what it COST, and of what it SOLD FOR. Both,
       because people say one and mean the other constantly. */
    markupPercent: decimalString({ default: undefined }),
    marginPercent: decimalString({ default: undefined }),
    /* The floor this price was judged against, so a reader sees the comparison
       and not only its verdict. Null on a historical row judged by a band. */
    floorPriceMinor: minorUnits({ default: null, allowNegative: false }),
    standing: {
      type: String,
      /* ── THREE ACTIVE, FOUR RETIRED ───────────────────────────────
         A new version records one of the first three: a proposed price is at
         or above the floor, below it, or there is no approved policy to judge
         it by. The four below are the retired band's vocabulary, kept in the
         enum because versions frozen under it hold them and must keep loading
         and reading back exactly what they froze. */
      enum: [
        "AT_OR_ABOVE_FLOOR", "BELOW_FLOOR", "POLICY_MISSING",
        "BELOW_MINIMUM", "WITHIN_POLICY", "MEETS_TARGET", "NO_POLICY",
      ],
      default: undefined,
    },
    /* Absent when no rate was configured — never 0, which would read as a
       tax-free business rather than an unanswered question. */
    estimatedIncomeTaxUnitMinor: minorUnits({ default: undefined }),
    estimatedIncomeTaxTotalMinor: minorUnits({ default: undefined }),
    afterTaxProfitUnitMinor: minorUnits({ default: undefined, allowNegative: true }),
    afterTaxProfitTotalMinor: minorUnits({ default: undefined, allowNegative: true }),
  },
  { _id: false },
);

const proposedPriceSchema = new mongoose.Schema(
  {
    scenarioKey: { type: String, required: true, trim: true, maxlength: 64 },
    priceExclTaxMinor: minorUnits({ required: true }),
    currency: { type: String, required: true, trim: true, maxlength: 3 },
  },
  { _id: false },
);

const commercialSchema = new mongoose.Schema(
  {
    currency: { type: String, trim: true, maxlength: 3 },
    /* Snapshotted from the policy, and labelled an estimate wherever it is
       shown. NOT a statutory rate, and not part of product cost. */
    estimatedIncomeTaxRatePercent: decimalString({ default: undefined }),
    incomeTaxRateSource: { type: String, trim: true, maxlength: 64, default: undefined },
    capturedAt: { type: Date },
    proposedPrices: { type: [proposedPriceSchema], default: () => [] },
    bridge: { type: [bridgeRowSchema], default: () => [] },
  },
  { _id: false },
);

/* ── WHETHER EVERY WAY THIS PRODUCT COSTS MONEY WAS ADDRESSED (Chunk 4C) ───
 * SERVER-DERIVED and frozen. A costing with one fabric line used to produce a
 * confident total while packaging, freight, duty, financing and overhead had
 * never been considered — the sections simply did not appear, and an absent
 * section reads as "none needed" rather than "nobody has looked".
 *
 * Frozen because the answer must not move: a supplier price revised next month
 * cannot make last month's assessment of what was CONSIDERED any different. */
const coverageFamilySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    label: { type: String, trim: true, maxlength: 120 },
    state: {
      type: String, required: true,
      enum: ["CALCULATED", "RECORDED_ZERO", "NOT_APPLICABLE", "NEEDS_INPUT", "SOURCE_UNAVAILABLE"],
    },
    /* Absent — not zero — for every state except the two that produced an
       amount. A family nobody is charging for has no amount, and writing zero
       would put it in a total as though it had been costed. */
    totalMinor: minorUnits({ default: undefined, allowNegative: true }),
    perUnitMinor: minorUnits({ default: undefined, allowNegative: true }),
    /* ── WHO WAS SUPPOSED TO ANSWER THIS, AND HOW ───────────────────────
       The assessment already carried these and threw them away at the door,
       so the screen could only ever offer the same generic answer: type a
       figure. For a family with a real source that is the WRONG answer — the
       fix is a quotation or a policy entry, by the desk named here — and for
       a family that genuinely has no source it is the right one. A reader
       cannot tell the two apart without this, and neither could the screen.

       Frozen rather than re-derived, because it is part of what the rules
       said when this version was made. Absent on versions frozen before it
       existed, which read exactly as they did then. */
    authority: { type: String, trim: true, maxlength: 40, default: undefined },
    ownerDepartment: { type: String, trim: true, maxlength: 120, default: undefined },
    ownerSystem: { type: String, trim: true, maxlength: 200, default: undefined },
    /* Where the figure came from, or where the decision was made. */
    basis: { type: String, trim: true, maxlength: 200, default: undefined },
    /* The prompt for a gap; the justification for a not-applicable. */
    reason: { type: String, trim: true, maxlength: 300, default: undefined },
    /* ── AND WHICH DEPARTMENT'S RECORD SAID SO ──────────────────────────
       A not-applicable family is answered by the department that owns the
       fact, in their own screen — Merchandising's packaging selection,
       Production's outside processes, Store's sourcing on the quotation. The
       record is named so a reader can go and check it rather than take the
       reason on trust.

       Absent on versions frozen while Costing owned this decision. Those
       carry the reason and the actor who typed it, and go on reading exactly
       as they did. */
    decidedByDepartment: { type: String, trim: true, maxlength: 120, default: undefined },
    decidedIn: { type: String, trim: true, maxlength: 200, default: undefined },
    /* Who decided, and when. Human judgement is attributable or it is not
       judgement. Read from the owning record — NOT stamped from whoever
       pressed Calculate, which is what it used to be. */
    decidedByActorId: { type: String, trim: true, maxlength: 64, default: undefined },
    decidedByName: { type: String, trim: true, maxlength: 200, default: undefined },
    decidedAt: { type: Date, default: undefined },
  },
  { _id: false },
);

const completenessSchema = new mongoose.Schema(
  {
    /* Assessed against the primary scenario's subtotals — the families and
       their states do not differ between quantities, only the amounts do. */
    scenarioKey: { type: String, trim: true, maxlength: 64 },
    families: { type: [coverageFamilySchema], default: () => [] },
    /* The one boolean, derived here and never accepted from a client. */
    costComplete: { type: Boolean, required: true },
    assessedAt: { type: Date, required: true },
    /* So a reader can tell an assessment made by this version of the rules
       from one made by a later set. */
    coverageSchemaVersion: { type: Number, required: true, default: 1 },
  },
  { _id: false },
);

const policySnapshotSchema = new mongoose.Schema(
  {
    policyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    revision: { type: Number, default: 0 },
    capturedAt: { type: Date, default: Date.now },

    baseCurrency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    roundingMode: { type: String, required: true, enum: ROUNDING_MODE_KEYS },
    sellingPriceIncrementMinor: { ...minorUnits({ required: true, allowNegative: false }), min: 1 },

    overheadBasis: { type: String, enum: BASIS_KEYS, default: undefined },
    overheadRatePercent: decimalString({ default: undefined }),
    /* Company-level rules, frozen with the rest. Absent means the company had
       not set one when this version was made — never a rate of nothing. */
    financingBasis: { type: String, enum: BASIS_KEYS, default: undefined },
    financingRatePercent: decimalString({ default: undefined }),
    contingencyBasis: { type: String, enum: BASIS_KEYS, default: undefined },
    contingencyRatePercent: decimalString({ default: undefined }),
    /* The assumptions the labour rate rested on, frozen so a version can say
       what its operation costs meant. Absent means the company had not stated
       them — and the operation lines on that version are provisional. */
    inputGstTreatment: { type: String, trim: true, default: undefined },
    productiveMinutesPerMonth: { type: Number },
    labourEfficiencyPercent: decimalString({ default: undefined }),
    employerBurdenPercent: decimalString({ default: undefined }),
    machineBurdenTreatment: { type: String, trim: true, default: undefined },

    /* ── THE PRICING RULE THIS VERSION WAS CALCULATED UNDER ───────────
       One markup, and the contract that says how to read it. Versions frozen
       before the markup policy carry the three band figures below instead —
       both blocks are optional, because which one a version has is a fact
       about when it was calculated, not a preference. */
    pricingContract: { type: String, trim: true, default: undefined },
    floorMarkupPercent: decimalString({ default: undefined }),

    /* RETIRED as inputs; still required reading on versions that froze them.
       No longer `required`, because a version priced by a markup has no band
       and inventing zeroes would claim a decision nobody took. */
    minimumMarginPercent: decimalString({ default: undefined }),
    targetMarginPercent: decimalString({ default: undefined }),
    preferredMarginPercent: decimalString({ default: undefined }),

    /* Declared, unused, and honest about it: Chunk 6 decides what crossing it
       requires. Storing it now means an approval added later can be judged
       against the policy that was in force when the costing was made. */
    approvalThresholdMarginPercent: decimalString({ default: undefined }),
    /* ── THE COMPANY'S OWN INCOME-TAX ESTIMATE, AS IT STOOD (Chunk 4B) ───
       Copied like every other policy figure. Revising the estimate next year
       must not restate the after-tax profit of a costing frozen this year. */
    estimatedIncomeTaxRatePercent: decimalString({ default: undefined }),
  },
  { _id: false },
);

/* One category's share of a scenario. */
const categorySubtotalSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, enum: CATEGORIES },
    /* Negative where a credit line makes a whole category negative. */
    totalMinor: minorUnits({ required: true }),
    perUnitMinor: minorUnits({ required: true }),
  },
  { _id: false },
);

/* One line, as it worked out at this quantity. */
const lineResultSchema = new mongoose.Schema(
  {
    lineKey: { type: String, required: true, trim: true },
    category: { type: String, required: true, enum: CATEGORIES },
    label: { type: String, trim: true, default: "" },
    behaviour: { type: String, required: true, enum: BEHAVIOURS },
    /* ── A THIRD STATE, EARNED RATHER THAN CLAIMED (Chunk 3.2) ──────────
       `SUPPLIER_QUOTATION` is not settable by a client — the parser refuses
       any client-supplied confidence but PROVISIONAL. It is applied by the
       server when it has itself read a dated, referenced quotation from the
       Store register and derived the rate. Without it, a quotation-backed
       line would read exactly like a typed guess, which is the distinction
       this chunk exists to draw. */
    confidence: { type: String, enum: ["PROVISIONAL", "VERIFIED", "SUPPLIER_QUOTATION"], default: "PROVISIONAL" },
    note: { type: String, trim: true, default: "" },

    unitRateMinor: minorUnits(),
    quantityPerUnit: decimalString({ default: undefined }),
    quantityUom: { type: String, trim: true, default: undefined },
    basis: { type: String, enum: BASIS_KEYS, default: undefined },
    percent: decimalString({ default: undefined }),
    basisAmountMinor: minorUnits(),

    perUnitMinor: minorUnits({ required: true }),
    totalMinor: minorUnits({ required: true }),
    /* Non-recoverable only. Recoverable tax never reaches a cost figure.
       Zero is the ordinary case and is a real statement — "no tax on this
       line" — so unlike the fields above it keeps an explicit default. */
    taxMinor: { ...minorUnits({ required: true }), default: 0 },
  },
  { _id: false },
);

/* ── THE ONE PRICE A NEW VERSION CARRIES ───────────────────────────────────
 * Floor = true unit cost x (1 + markup/100), raised to the company's saleable
 * increment. Everything a reader needs to check that arithmetic years later is
 * here, because the policy it came from may have been superseded twice since.
 *
 * `calculationMethod` is stored on every entry and not implied: a version that
 * merely held a price and a percentage could be re-read under either formula,
 * and the two differ by real money. */
const floorSchema = new mongoose.Schema(
  {
    /* The Board's figure, as approved. */
    floorMarkupPercent: decimalString({ required: true }),
    calculationMethod: { type: String, required: true, trim: true, default: "MARKUP_ON_TRUE_COST" },
    /* What the markup was applied TO — the garment's own cost, excluding money
       the customer reimburses separately at cost. */
    trueUnitCostMinor: minorUnits({ required: true }),
    markupAmountMinor: minorUnits({ required: true, allowNegative: true }),
    floorPriceMinor: minorUnits({ required: true, allowNegative: false }),
    /* Both halves of the rounding, so the published price can be reproduced
       exactly rather than approximately. */
    roundingIncrementMinor: { type: Number, default: 1 },
    roundingUpliftMinor: minorUnits({ default: 0, allowNegative: true }),
    /* Null on a floor of nil rather than a fabricated zero: a free garment has
       no percentage return, and dividing by its price would be dividing by
       zero. */
    realisedReturnOnPricePercent: decimalString({ default: null }),
  },
  { _id: false },
);

/* One selling price in the band. RETIRED — see `scenarioSchema.prices`. */
const priceSchema = new mongoose.Schema(
  {
    requestedMarginPercent: decimalString({ required: true }),
    /* The one figure whose domain has no negative meaning: there is no such
       thing as a selling price below nothing. */
    priceMinor: minorUnits({ required: true, allowNegative: false }),
    /* What the rounded price actually realises. Rounding up to a saleable
       increment always lands slightly above the requested margin, and saying
       so is the difference between a price and a claim about a price. */
    effectiveMarginPercent: decimalString({ required: true }),
  },
  { _id: false },
);

/* Why this scenario's unit cost differs from the primary one. */
const comparisonSchema = new mongoose.Schema(
  {
    againstScenarioKey: { type: String, required: true, trim: true },
    /* Deltas. Negative is the normal case — that is what dilution looks like. */
    unitCostDeltaMinor: minorUnits({ required: true }),
    /* In this chunk the whole difference should be here: quantity changes cost
       only by spreading fixed cost. */
    fixedDilutionMinor: minorUnits({ required: true }),
    /* And this should be zero until Chunk 3 brings supplier quantity tiers.
       Kept so a future non-zero value has somewhere honest to go, rather than
       being folded into the dilution figure and misdescribed. */
    variableChangeMinor: minorUnits({ required: true }),
    roundingMinor: { ...minorUnits({ required: true }), default: 0 },
    /* ── WHY, LINE BY LINE (Chunk 5A) ───────────────────────────────────
       The two lump figures above say how much moved; they cannot say what
       moved it. A person reading "61 lower" cannot act on it and cannot
       check it — they need to know that 42 came from a quoted tier on the
       fabric line and 19 from spreading the setup.

       Only four causes exist, and each is a fact this engine can point at.
       Generic bulk discounts, operation efficiency, reduced wastage and
       freight consolidation are deliberately absent: each needs a policy or
       a record that does not exist yet, and presenting one as a saving would
       put a number in front of a customer nobody can stand behind. */
    causes: {
      type: [new mongoose.Schema({
        cause: { type: String, required: true, enum: EOS_CAUSES },
        lineKey: { type: String, trim: true, required: true },
        category: { type: String, enum: CATEGORIES },
        label: { type: String, trim: true, maxlength: 300, default: "" },
        primaryPerUnitMinor: minorUnits(),
        comparedPerUnitMinor: minorUnits(),
        perUnitDeltaMinor: minorUnits(),
        /* Per-unit rates, present where a supplier tier moved. */
        primaryRateMinor: minorUnits(),
        comparedRateMinor: minorUnits(),
        /* Identical by construction on a dilution — stated so a reader can
           see that the fixed TOTAL did not change, only its allocation. */
        primaryTotalMinor: minorUnits(),
        comparedTotalMinor: minorUnits(),
        source: { type: String, trim: true },
      }, { _id: false })],
      default: undefined,
    },
    /* ── THE PART NOBODY EXPLAINED ──────────────────────────────────────
       Said rather than absorbed. An unexplained residue is where a claim
       nobody can support would otherwise hide. */
    unattributedMinor: { ...minorUnits(), default: undefined },
    againstQuantity: decimalString({ default: undefined }),
    reason: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { _id: false },
);

const scenarioSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    label: { type: String, trim: true, maxlength: 200, default: "" },
    quantity: decimalString({ required: true }),
    quantityUom: { type: String, trim: true, maxlength: 32, default: undefined },
    isPrimary: { type: Boolean, default: false },

    /* No defaults: an absent total means "not calculated", which a zero would
       misreport as "costs nothing". */
    totalCostMinor: minorUnits(),
    unitCostMinor: minorUnits(),
    fixedTotalMinor: minorUnits(),
    fixedPerUnitMinor: minorUnits(),
    variableTotalMinor: minorUnits(),
    variablePerUnitMinor: minorUnits(),
    /* unit × quantity minus the total. Named rather than hidden, and signed. */
    roundingAdjustmentMinor: { ...minorUnits({ required: true }), default: 0 },
    /* Funded by the buyer, reclaimed by the company, never part of cost. */
    recoverableTaxMinor: { ...minorUnits({ required: true }), default: 0 },
    /* ── PAID BY US, BILLED TO THEM ───────────────────────────────────
       Prepaid freight the customer reimburses at cost. It is inside
       `totalCostMinor` — the money leaves — and OUTSIDE `pricedUnitCostMinor`,
       because a margin on somebody's own reimbursement is not a margin
       anybody agreed to. Both figures are stored so a reader can see the
       split rather than re-derive it. */
    recoveredSeparatelyMinor: { ...minorUnits(), default: 0 },
    recoveredSeparatelyPerUnitMinor: { ...minorUnits(), default: 0 },
    /* What the selling prices below were actually derived from. */
    pricedUnitCostMinor: { ...minorUnits(), default: undefined },

    categorySubtotals: { type: [categorySubtotalSchema], default: () => [] },
    lines: { type: [lineResultSchema], default: () => [] },

    /* ── THE FLOOR, ON EVERY VERSION CALCULATED SINCE THE MARKUP MODEL ──
       Exactly one price. A version has this OR `prices` below, never both:
       which one it has is which pricing contract was in force when it was
       calculated, and that is a fact about the version rather than a
       preference a reader gets to apply. */
    floor: { type: floorSchema, default: undefined },

    /* ── AND THE RETIRED BAND, ON VERSIONS THAT FROZE ONE ────────────────
       Kept exactly as stored. These priced real quotations under a policy the
       Board really approved, and they are read, never recomputed: re-deriving
       them under the markup formula would rewrite history to say the company
       quoted prices it never quoted.

       Absent on every new version — not empty, absent — so nothing looking
       for a band on a floor-priced version can find three blank tiers and
       render them as prices. */
    prices: {
      minimum: { type: priceSchema, default: undefined },
      target: { type: priceSchema, default: undefined },
      preferred: { type: priceSchema, default: undefined },
    },

    comparedToPrimary: { type: comparisonSchema, default: null },
  },
  { _id: false },
);

/* Something the engine wants a reader to know, that is not an error. */
const warningSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 64 },
    message: { type: String, trim: true, maxlength: 500, default: "" },
    lineKeys: { type: [String], default: undefined },
  },
  { _id: false },
);

module.exports = {
  DECIMAL_PATTERN, decimalString, minorUnits, moneySchema,
  costLineSchema, policySnapshotSchema, scenarioSchema, warningSchema, commercialSchema,
  completenessSchema,
  categorySubtotalSchema, lineResultSchema, priceSchema, comparisonSchema,
};
