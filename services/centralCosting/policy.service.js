// services/centralCosting/policy.service.js
//
// Central Costing — Chunk 2. READING, CHANGING AND FREEZING COMPANY POLICY.
//
// ── THE ORDERING RULE LIVES HERE, NOT IN THE SCHEMA ─────────────────────────
//     0 ≤ minimum ≤ target ≤ preferred < 100
// A mongoose validator sees one path at a time and, on a partial update, sees
// only the paths being written — so "raise the minimum above the existing
// target" would pass a field-level check and leave the company with a floor
// above its own ceiling. The band is therefore validated as a WHOLE, against
// the merged result of the change, every time.
//
// ── AND WHY 100% IS EXCLUDED ────────────────────────────────────────────────
// price = cost / (1 - m). At m = 1 the divisor is zero: there is no price that
// yields a 100% margin, and accepting the number would produce an infinity
// somewhere downstream rather than a refusal here.
"use strict";

const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const { percent, ROUNDING_MODE_KEYS, DecimalError } = require("./decimal");
const { parseCurrency, MoneyError } = require("./money");
const { fail } = require("../storePurchase/errors");
/* One adapter, one resolver — shared with the assembly, so the table Finance
   writes and the table the engine reads can never be two readings. */
const { adaptTable } = require("./developmentCharges");
/* The Board's overhead rule, resolved for the costing's own date. */
const overheadPolicy = require("./overheadPolicy.service");
/* The Board's labour methodology, resolved for the costing's own date. */
const labourPolicy = require("./labourPolicy.service");
/* The Board's input GST treatment, resolved for the costing's own date. */
const gstPolicy = require("./gstPolicy.service");
// The Board's approved development charge catalogue, on the same seam.
const developmentChargePolicy = require("./developmentChargePolicy.service");
// And whether the company adds a standard contingency, on the same seam.
const contingencyPolicy = require("./contingencyPolicy.service");
// And what the company is prepared to sell for, on the same seam.
const marginPolicy = require("./marginPolicy.service");

/* The enums the schema already enforces, named here so a bad value is refused
   with a field and a reason rather than as a Mongoose validation error. */
const GST_TREATMENTS = ["RECOVERABLE", "NON_RECOVERABLE"];
const MACHINE_BURDEN_TREATMENTS = ["IN_OPERATION_RATE", "IN_OVERHEAD", "NOT_COSTED"];

const bad = (message, details) => fail("VALIDATION", message, details);

/** Translate the pure parsers' errors into the API's refusal shape. */
const lift = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DecimalError || err instanceof MoneyError) throw bad(err.message, err.details);
    throw err;
  }
};

/**
 * The policy a company falls back to before anybody has set one.
 *
 * ── WHY THE MARGINS ARE ZERO AND NOT A GUESSED 22% ──────────────────────────
 * `services/costingTotals.js` carries a 22% markup default for the legacy
 * Sales floor price. Copying it here would look helpful and would be a
 * business decision this code is not entitled to make: it would put a number
 * on every unconfigured company's quotations that nobody in that company
 * chose. Zero margins mean "selling price equals cost", which is obviously
 * unfinished, and the response says `configured: false` so a screen can say so
 * rather than presenting a default as a decision.
 */
const DEFAULTS = Object.freeze({
  baseCurrency: "INR",
  roundingMode: "HALF_UP",
  sellingPriceIncrementMinor: 1,
  overheadBasis: undefined,
  overheadRatePercent: undefined,
  /* Absent, not zero — a company that has not set a financing or contingency
     rule has neither applied, and its costings say so. A 0% default would
     read as "this company borrows for nothing". */
  financingBasis: undefined,
  financingRatePercent: undefined,
  contingencyBasis: undefined,
  contingencyRatePercent: undefined,
  /* Empty, and never seeded. A company that has configured no development
     charges has none — and a costing that needs one is blocked and names
     Finance, rather than quietly using an amount nobody agreed. */
  developmentCharges: [],
  /* The three assumptions an operation rate rests on. Absent until set — see
     the schema for why none of them can be guessed. */
  inputGstTreatment: undefined,
  productiveMinutesPerMonth: undefined,
  labourEfficiencyPercent: undefined,
  employerBurdenPercent: undefined,
  machineBurdenTreatment: undefined,
  /* ── THE MARGIN BAND NO LONGER DEFAULTS TO ZERO ──────────────────────
     It read `"0"` for all three, with a separate `configured` flag carrying
     the difference between a company that meant nil and one that had never
     opened the screen. The flag worked and `profitBridge` still honours it,
     but a default that the ENGINE accepts is a default that can price a
     garment, and "priced at a margin nobody chose" is the one outcome this
     family cannot allow.

     Absent now. The Board's approved band fills these three, and a company
     with no approved band is refused by name rather than quietly sold at
     cost. */
  minimumMarginPercent: undefined,
  targetMarginPercent: undefined,
  preferredMarginPercent: undefined,
  approvalThresholdMarginPercent: undefined,
  /* Absent, not zero — see the schema. */
  estimatedIncomeTaxRatePercent: undefined,
  revision: 0,
});

/**
 * This company's policy, or the unconfigured default.
 *
 * @returns {Promise<{policy: object, configured: boolean, doc: object|null}>}
 */
async function getPolicy(ctx, { asOf = new Date() } = {}) {
  const doc = await CostingPolicy.findOne({ companyId: ctx.companyId }).lean();

  /* ── THE BOARD'S OVERHEAD RULE, FOR THIS COSTING'S DATE ───────────────
     Resolved here rather than in the engine, and here rather than at every
     call site, for one reason each:

       · not the engine, because `engine.js` reads `policy.overheadRatePercent`
         and `policy.overheadBasis` and synthesises the line from them. Filling
         those two fields from the Board record instead of from this document
         leaves the basis graph, the ordering, the rounding and the arithmetic
         untouched — there is no version of this migration where the engine had
         to be re-read to be sure the number still comes out the same;

       · not every call site, because a second place that resolves the rate is
         a second answer, and the one nobody updates is the one some screen
         reads.

     `asOf` defaults to now, which is right for a policy screen and for a fresh
     preview. A version being FROZEN passes the costing's own date, so a
     costing dated in March is calculated at March's rate and a policy approved
     since — even one backdated — is simply not the version this selects. */
  const overhead = await overheadPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardOverhead = overhead ? overheadPolicy.overlayFor(overhead) : {};

  /* ── AND THE BOARD'S LABOUR METHODOLOGY, ON THE SAME SEAM ─────────────
     The four names `labourCost.js` reads, filled from the Board's approved
     version rather than from this document. Same reasoning as overhead: the
     arithmetic keeps its input shape, so the formula, the decimal handling and
     the single rounding point are untouched by the migration. */
  const labour = await labourPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardLabour = labour ? labourPolicy.overlayFor(labour) : {};

  /* ── AND WHETHER INPUT GST IS RECLAIMED, ON THE SAME SEAM ─────────────
     The one name `offerPricing.taxPositionFor` reads, through every family:
     materials, packaging, outside services, bought-in development and
     freight are all handed `policy.inputGstTreatment` from this object. One
     overlay, one resolution, and the quotation's own `NON_TAXABLE` precedence
     untouched. */
  const gst = await gstPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardGst = gst ? gstPolicy.overlayFor(gst) : {};

  /* ── AND WHAT THE COMPANY CHARGES FOR ITS OWN DEVELOPMENT WORK ────────
     The one name `applyDevelopmentCharges` reads. Filling it from the Board's
     approved catalogue leaves `developmentCharges.js` — the period selection,
     the two calculations and the exact-decimal handling — entirely untouched;
     only WHICH catalogue it reads changes.

     Note the two dating layers meeting here: this `asOf` picks the approved
     VERSION, and the rate periods inside the charge it hands back pick the
     rate. Both are needed. */
  const development = await developmentChargePolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardDevelopment = development ? developmentChargePolicy.overlayFor(development) : {};

  /* ── AND WHETHER A STANDARD CONTINGENCY IS ADDED AT ALL ───────────────
     The two names `engine.js` reads to synthesise its `MISC` line. Filling
     them from the Board's approved decision leaves the line's ordering
     against every other percentage line, its basis resolution and its single
     rounding point exactly as they are.

     A decision of NONE fills NEITHER — deliberately. The engine already tells
     an explicit 0% (a real zero line) from an absent rate (no line), and a
     company that decided it does not add contingency has not set it to nil.
     What makes that an audited nothing rather than a silence is
     `contingencyProvenance` on the version, not a fabricated line. */
  const contingency = await contingencyPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardContingency = contingency ? contingencyPolicy.overlayFor(contingency) : {};

  /* ── AND WHAT THE COMPANY IS PREPARED TO SELL FOR ─────────────────────
     The three names `engine.js` solves every price break from, plus the two
     profit assumptions `profitBridge` reads. Filling them from the Board's
     approved band leaves `priceFor`, the rounding to the selling-price
     increment and the standing comparison exactly as they are — the only
     thing that changed is that somebody approved the numbers.

     When no band is approved this fills NOTHING, and the engine's own
     requirement then stops the costing. That is deliberate: this is the one
     policy in the family whose absence must not be survivable, because the
     alternative is a price. */
  const margin = await marginPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const boardMargin = margin ? marginPolicy.overlayFor(margin) : {};

  if (!doc) {
    return {
      policy: {
        ...DEFAULTS, ...boardOverhead, ...boardLabour, ...boardGst,
        ...boardDevelopment, ...boardContingency, ...boardMargin,
      },
      configured: false,
      doc: null,
      overhead: overhead || null,
      labour: labour || null,
      gst: gst || null,
      development: development || null,
      contingency: contingency || null,
      margin: margin || null,
    };
  }
  return {
    configured: true,
    doc,
    /* The Board's resolution, carried so a caller that has to FREEZE it does
       not resolve it a second time and risk provenancing a version with one
       answer and calculating it with another. */
    overhead: overhead || null,
    labour: labour || null,
    gst: gst || null,
    development: development || null,
    contingency: contingency || null,
    margin: margin || null,
    policy: {
      ...boardOverhead,
      ...boardLabour,
      ...boardGst,
      ...boardDevelopment,
      ...boardContingency,
      ...boardMargin,
      baseCurrency: doc.baseCurrency,
      roundingMode: doc.roundingMode,
      sellingPriceIncrementMinor: doc.sellingPriceIncrementMinor,
      /* ── THE LEGACY FIELDS ARE NOT READ INTO THE CALCULATION ───────
         They stay on the document and on every historical snapshot so an old
         version remains explicable, and `legacyOverhead` below publishes them
         for the screen that has to show a company what it is still carrying.
         What they no longer do is feed a costing: applying an unapproved value
         under a Board-governed family would be treating it as Board-approved,
         which is the one thing this migration must not do. */
      legacyOverheadBasis: doc.overheadBasis,
      legacyOverheadRatePercent: doc.overheadRatePercent,
      financingBasis: doc.financingBasis,
      financingRatePercent: doc.financingRatePercent,
      /* ── THE LEGACY CONTINGENCY RULE IS NOT READ INTO THE CALCULATION ─
         It stays on the document and on every historical snapshot so an old
         version remains explicable, and `legacyContingency*` publishes it for
         the screen that has to show a company what it is still carrying — and
         for the Board to COPY into a draft, which is the one route by which
         this rate can become company policy again.

         What it no longer does is charge a costing: applying an unapproved
         rate under a Board-governed family would be treating it as
         Board-approved. */
      legacyContingencyBasis: doc.contingencyBasis,
      legacyContingencyRatePercent: doc.contingencyRatePercent,
      /* ── THE LEGACY CHARGE TABLE IS NOT READ INTO THE CALCULATION ───
         It stays on the document and on every historical snapshot so an old
         version remains explicable, and `legacyDevelopmentCharges` publishes
         it for the screen that has to show a company what it is still
         carrying — and for the Board to COPY into a draft, which is the one
         route by which these amounts can become company policy again.

         Adapted on the way out, once, so a charge configured before rate
         periods existed is read as the single period it always was rather
         than being invisible to whoever reviews it. */
      legacyDevelopmentCharges: adaptTable(doc.developmentCharges),
      /* ── THE LEGACY TREATMENT IS NOT READ INTO THE CALCULATION ──────
         It stays on the document and on every historical snapshot so an old
         version remains explicable, and `legacyInputGstTreatment` publishes it
         for the screen that has to show a company what it is still carrying.
         What it no longer does is price a line: applying an unapproved value
         under a Board-governed family would be treating it as
         Board-approved. */
      legacyInputGstTreatment: doc.inputGstTreatment,
      /* ── THE LEGACY LABOUR FIELDS ARE NOT READ INTO THE CALCULATION ──
         They stay on the document and on every historical snapshot so an old
         version remains explicable, and `legacyLabour*` below publishes them
         for the screen that has to show a company what it is still carrying.
         What they no longer do is feed a costing: applying unapproved
         assumptions under a Board-governed family would be treating them as
         Board-approved. */
      legacyProductiveMinutesPerMonth: doc.productiveMinutesPerMonth,
      legacyLabourEfficiencyPercent: doc.labourEfficiencyPercent,
      legacyEmployerBurdenPercent: doc.employerBurdenPercent,
      legacyMachineBurdenTreatment: doc.machineBurdenTreatment,
      /* ── THE LEGACY MARGIN BAND IS NOT READ INTO THE CALCULATION ────
         It stays on the document and on every historical snapshot so an old
         version remains explicable, and `legacy*` publishes it for the screen
         that has to show a company what it is still carrying — and for the
         Board to COPY into a draft.

         What it no longer does is price anything: selling a garment at a
         margin nobody approved is the exact outcome this migration exists to
         stop, and it is the one field family where doing so produces a real
         number rather than a gap. */
      legacyMinimumMarginPercent: doc.minimumMarginPercent,
      legacyTargetMarginPercent: doc.targetMarginPercent,
      legacyPreferredMarginPercent: doc.preferredMarginPercent,
      legacyApprovalThresholdMarginPercent: doc.approvalThresholdMarginPercent,
      legacyEstimatedIncomeTaxRatePercent: doc.estimatedIncomeTaxRatePercent,
      revision: doc.revision,
    },
  };
}

/**
 * The frozen copy that goes into a version.
 *
 * Built from the same object the engine is handed, so a version can never
 * record one policy and be calculated with another.
 */
const snapshotOf = ({ policy, doc }) => ({
  policyId: doc?._id ?? null,
  revision: policy.revision ?? 0,
  capturedAt: new Date(),
  baseCurrency: policy.baseCurrency,
  roundingMode: policy.roundingMode,
  sellingPriceIncrementMinor: policy.sellingPriceIncrementMinor,
  ...(policy.overheadBasis ? { overheadBasis: policy.overheadBasis } : {}),
  ...(policy.overheadRatePercent !== undefined && policy.overheadRatePercent !== null
    ? { overheadRatePercent: policy.overheadRatePercent } : {}),
  /* Omitted when unset rather than snapshotted as null: an absent key is an
     absent rule, and a null would be a rule whose value nobody supplied. */
  ...(policy.financingBasis ? { financingBasis: policy.financingBasis } : {}),
  ...(policy.financingRatePercent !== undefined && policy.financingRatePercent !== null
    ? { financingRatePercent: policy.financingRatePercent } : {}),
  ...(policy.contingencyBasis ? { contingencyBasis: policy.contingencyBasis } : {}),
  ...(policy.contingencyRatePercent !== undefined && policy.contingencyRatePercent !== null
    ? { contingencyRatePercent: policy.contingencyRatePercent } : {}),
  /* ── THE CHARGE TABLE, FROZEN WITH THE REST ────────────────────────
     The Board's approved catalogue as it stood, not this document's: what is
     handed here is what the overlay resolved for the costing's date. A costing
     from March must go on saying what the March charge was, and the Board
     approving next quarter's must not re-price it. Omitted entirely when no
     catalogue applied — an empty array stored on every historical version
     would be a table nobody had. */
  ...(Array.isArray(policy.developmentCharges) && policy.developmentCharges.length
    ? { developmentCharges: policy.developmentCharges.map((c) => ({
      key: c.key, label: c.label, description: c.description || "",
      calculation: c.calculation || "FLAT_PER_RUN",
      ...(c.unit ? { unit: c.unit } : {}),
      /* Every period, not only the one this version used — so a reader can
         see what the table looked like when the figure was frozen. */
      rates: (c.rates || []).map((r) => ({
        amountMinor: r.amountMinor, currency: r.currency || "INR",
        effectiveFrom: r.effectiveFrom || null,
        effectiveTo: r.effectiveTo || null,
      })),
      active: c.active !== false,
    })) }
    : {}),
  /* Frozen with the rest: a version has to say which productivity assumption
     its labour rate was calculated under. */
  ...(policy.inputGstTreatment ? { inputGstTreatment: policy.inputGstTreatment } : {}),
  ...(policy.productiveMinutesPerMonth ? { productiveMinutesPerMonth: policy.productiveMinutesPerMonth } : {}),
  ...(policy.labourEfficiencyPercent !== undefined && policy.labourEfficiencyPercent !== null
    ? { labourEfficiencyPercent: policy.labourEfficiencyPercent } : {}),
  ...(policy.employerBurdenPercent !== undefined && policy.employerBurdenPercent !== null
    ? { employerBurdenPercent: policy.employerBurdenPercent } : {}),
  ...(policy.machineBurdenTreatment ? { machineBurdenTreatment: policy.machineBurdenTreatment } : {}),
  /* ── THE PRICING RULE THIS VERSION WAS CALCULATED UNDER ─────────────
     One markup and the contract naming the formula, so a reader years later
     can reproduce the floor exactly rather than assume which arithmetic
     produced it. Omitted when absent — never defaulted to a zero markup,
     which would read as an approved decision to sell at cost. */
  ...(policy.floorMarkupPercent !== undefined && policy.floorMarkupPercent !== null
    ? { floorMarkupPercent: policy.floorMarkupPercent, pricingContract: "MARKUP_FLOOR_V2" } : {}),
  /* RETIRED, and omitted rather than nulled on a version priced by a markup:
     three empty band fields would invite a reader to render three tiers. */
  ...(policy.minimumMarginPercent !== undefined && policy.minimumMarginPercent !== null
    ? { minimumMarginPercent: policy.minimumMarginPercent } : {}),
  ...(policy.targetMarginPercent !== undefined && policy.targetMarginPercent !== null
    ? { targetMarginPercent: policy.targetMarginPercent } : {}),
  ...(policy.preferredMarginPercent !== undefined && policy.preferredMarginPercent !== null
    ? { preferredMarginPercent: policy.preferredMarginPercent } : {}),
  ...(policy.approvalThresholdMarginPercent !== undefined && policy.approvalThresholdMarginPercent !== null
    ? { approvalThresholdMarginPercent: policy.approvalThresholdMarginPercent } : {}),
  /* ── SNAPSHOTTED, SO AN OLD COSTING KEEPS ITS OWN ASSUMPTION ─────────
     The rate changes when the company revises its estimate. A version that
     showed an after-tax profit at 25% must go on saying it was 25%, or
     every historical costing silently re-states its profit the day somebody
     edits the policy. Omitted entirely when unset — a stored null would be
     a rate of nothing. */
  ...(policy.estimatedIncomeTaxRatePercent !== undefined && policy.estimatedIncomeTaxRatePercent !== null
    ? { estimatedIncomeTaxRatePercent: policy.estimatedIncomeTaxRatePercent } : {}),
});

/**
 * Validate a proposed policy, as a whole.
 *
 * @param {object} current  what the company has now (or the defaults)
 * @param {object} patch    only the fields the caller sent
 * @returns {object} the merged, validated policy fields ready to write
 */
function validatePatch(current, patch = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const merged = { ...current };

  /* ── THE LEGACY OVERHEAD VALUES, CARRIED THROUGH UNTOUCHED ────────────
     `getPolicy` deliberately stops projecting `overheadBasis` /
     `overheadRatePercent` into the calculation — the Board's rule fills those
     two names now. But `savePolicy` writes this merged object back and
     `$unset`s anything undefined, so without this a save of an UNRELATED
     field would silently wipe a company's legacy overhead: the exact data
     this migration promised to keep so old frozen versions stay explicable.

     So they are seeded from what is stored, and the only thing that clears
     them is somebody explicitly clearing them below. */
  merged.overheadBasis = current?.legacyOverheadBasis;
  merged.overheadRatePercent = current?.legacyOverheadRatePercent;

  /* The four labour assumptions, on exactly the same terms and for exactly the
     same reason — `getPolicy` stopped projecting them, and without this a save
     of an unrelated field would `$unset` the values kept to explain old frozen
     versions. */
  merged.inputGstTreatment = current?.legacyInputGstTreatment;
  merged.productiveMinutesPerMonth = current?.legacyProductiveMinutesPerMonth;
  merged.labourEfficiencyPercent = current?.legacyLabourEfficiencyPercent;
  merged.employerBurdenPercent = current?.legacyEmployerBurdenPercent;
  merged.machineBurdenTreatment = current?.legacyMachineBurdenTreatment;

  /* And the charge table, on the same terms. This one carries more than the
     others — labels, descriptions, calculation modes and every historical rate
     period — and it is the material the Board copies into its first draft, so
     losing it to an unrelated save would lose the migration's own source. */
  merged.developmentCharges = current?.legacyDevelopmentCharges;

  /* And the contingency rule, on the same terms and for the same reason —
     `getPolicy` stopped projecting these two names, so without this a save of
     an unrelated field would `$unset` the values kept to explain old frozen
     versions and to seed the Board's first draft. */
  merged.contingencyBasis = current?.legacyContingencyBasis;
  merged.contingencyRatePercent = current?.legacyContingencyRatePercent;

  /* And the margin band and profit assumptions, on the same terms. This is the
     family where losing them would matter most: they are what the Board copies
     into its first draft, and until it does, the company cannot price at all. */
  merged.minimumMarginPercent = current?.legacyMinimumMarginPercent;
  merged.targetMarginPercent = current?.legacyTargetMarginPercent;
  merged.preferredMarginPercent = current?.legacyPreferredMarginPercent;
  merged.approvalThresholdMarginPercent = current?.legacyApprovalThresholdMarginPercent;
  merged.estimatedIncomeTaxRatePercent = current?.legacyEstimatedIncomeTaxRatePercent;

  if (has("baseCurrency")) {
    merged.baseCurrency = lift(() => parseCurrency(patch.baseCurrency, { field: "baseCurrency" }));
  }

  if (has("roundingMode")) {
    const mode = String(patch.roundingMode || "").toUpperCase();
    if (!ROUNDING_MODE_KEYS.includes(mode)) {
      throw bad("That is not a rounding rule this system supports.", {
        field: "roundingMode", reason: "ROUNDING_MODE_UNKNOWN", allowed: ROUNDING_MODE_KEYS,
      });
    }
    merged.roundingMode = mode;
  }

  if (has("sellingPriceIncrementMinor")) {
    const inc = patch.sellingPriceIncrementMinor;
    if (!Number.isSafeInteger(inc) || inc < 1) {
      throw bad("The selling-price step must be a whole number of minor units, at least 1.", {
        field: "sellingPriceIncrementMinor", reason: "INCREMENT_INVALID", value: inc,
      });
    }
    merged.sellingPriceIncrementMinor = inc;
  }

  /* ── OVERHEAD HAS MOVED, AND THIS IS NOT A SECOND WAY IN ─────────────
     The two fields below stay on the model and on every version snapshot, so
     costings frozen under the old flat rule remain explicable. What they no
     longer are is WRITABLE.

     What the company adds to every garment to cover what it costs to run is a
     governed decision — approved by a named person, effective from a date,
     superseded rather than overwritten — and a company that could still set a
     rate here would have two overhead rules with nothing deciding which one
     applied. See `services/board/boardPolicy.service.js`.

     Refused by NAME rather than ignored, exactly as financing is: silently
     dropping the field would leave whoever sent it believing the rate was
     saved, which is the worse of the two failures by a distance — and for
     overhead it would be worse still, because the value they thought they had
     set is the one applied to every garment the company quotes.

     CLEARING is allowed, and only clearing: a company retiring its legacy rate
     should be able to, through the screen it was set in, without that being a
     write path for a new one. */
  for (const key of ["overheadBasis", "overheadRatePercent"]) {
    if (!has(key)) continue;
    const value = patch[key];
    const clearing = value === null || value === "" || value === undefined;
    if (clearing) {
      merged.overheadBasis = undefined;
      merged.overheadRatePercent = undefined;
      continue;
    }
    throw fail(
      "OVERHEAD_POLICY_MOVED",
      "Company and factory overhead is set by the Board, with an effective date and an approver, and is "
      + "no longer part of the costing policy. This field can only be cleared here.",
      {
        field: key,
        reason: "OVERHEAD_POLICY_MOVED",
        /* Named so a stale client can say where it went, without this becoming
           a redirect that sends an operational user into a Board screen they
           may not be able to open. */
        ownedBy: "BOARD",
        policyKey: "OVERHEAD",
      },
    );
  }

  /* ── FINANCING AND CONTINGENCY, ON THE SAME BOTH-OR-NEITHER RULE ──────
     These were readable, snapshottable, and raised as cost lines by the
     engine — and there was no way to SET them. Every assembly reported
     "Company financing policy is not configured", named Finance as its
     owner, and Finance had no field to answer with. While a costing could
     still carry a hand-typed FINANCING line the gap was survivable; once
     manual lines were closed it left a cost family that nothing in the
     system could ever charge. */
  /* ── FINANCING HAS MOVED, AND THIS IS NOT A SECOND WAY IN ─────────────
     The two fields below stay on the model and on every version snapshot, so
     costings frozen under the old flat rate remain explicable. What they no
     longer are is WRITABLE: the cost of money is a Board decision with a
     methodology, an effective date and an approver — see
     `services/board/boardPolicy.service.js` — and a company that could still
     set a rate here would have two financing rules with nothing deciding
     which one applies.

     Refused by NAME rather than ignored. Silently dropping the field would
     leave whoever sent it believing the rate was saved, which is the worse of
     the two failures by a distance.

     CLEARING is allowed, and only clearing: a company retiring its legacy
     rate should be able to, through the screen it was set in, without that
     being a write path for a new one. */
  for (const key of ["financingBasis", "financingRatePercent"]) {
    if (!has(key)) continue;
    const value = patch[key];
    const clearing = value === null || value === "" || value === undefined;
    if (clearing) {
      merged.financingBasis = undefined;
      merged.financingRatePercent = undefined;
      continue;
    }
    throw fail(
      "FINANCING_POLICY_MOVED",
      "The cost of financing is set by the Board, with a methodology and an effective date, and is no "
      + "longer part of the costing policy. This field can only be cleared here.",
      {
        field: key,
        reason: "FINANCING_POLICY_MOVED",
        /* Named so a stale client can say where it went, without this
           becoming a redirect that sends an operational user into Costing. */
        ownedBy: "BOARD",
        policyKey: "FINANCING",
      },
    );
  }

  /* ── CONTINGENCY HAS LEFT ─────────────────────────────────────────────
     Whether the company adds a cushion to everything it quotes, and on what,
     is a company-wide commercial posture — not a Finance setting. It is now
     approved as `CONTINGENCY_POLICY`, with a mode, an effective date and an
     approver, and with a decision NOT to apply one recorded as explicitly as
     a decision to apply one.

     The rate and basis stay on this document, and `legacyContingency*`
     publishes them, so a costing frozen against them stays explicable and so
     the Board has something to COPY into a first draft. What they can no
     longer do is take a new value: a rate written here would charge every
     costing in the company without anybody having approved it.

     Clearing is still allowed — retiring what a company no longer wants to
     display is not authoring policy. */
  const CONTINGENCY_FIELDS = ["contingencyBasis", "contingencyRatePercent"];
  for (const key of CONTINGENCY_FIELDS) {
    if (!has(key)) continue;
    const value = patch[key];
    const clearing = value === null || value === "" || value === undefined;
    if (clearing) {
      /* Both together: half a rule is not a rule, and leaving a basis behind
         a cleared rate would be a percentage of something, of nothing. */
      for (const f of CONTINGENCY_FIELDS) merged[f] = undefined;
      continue;
    }
    throw fail(
      "CONTINGENCY_POLICY_MOVED",
      "Whether the company adds a standard contingency, and on what subtotal, is decided by the "
      + "Board, with an effective date and an approver, and is no longer part of the costing policy. "
      + "These fields can only be cleared here.",
      {
        field: key,
        reason: "CONTINGENCY_POLICY_MOVED",
        ownedBy: "BOARD",
        policyKey: "CONTINGENCY_POLICY",
        fields: [...CONTINGENCY_FIELDS],
      },
    );
  }

  /* ── THE ASSUMPTIONS A LABOUR RATE AND A QUOTED MATERIAL REST ON ──────
     Same story, and worse: `labourCost.js` refuses to produce a rate without
     the productive basis and the employer burden, and `assembly.js` refuses a
     quotation-backed material without the input-GST treatment. Both refusals
     are right. Neither field could be written through the only route that
     writes the policy, so a correctly-configured company was unreachable and
     no source-backed costing could be calculated at all. */
  /* ── INPUT GST TREATMENT HAS MOVED, AND THIS IS NOT A SECOND WAY IN ───
     The field below stays on the model and on every version snapshot, so
     costings frozen under it remain explicable. What it no longer is is
     WRITABLE.

     Whether eligible input tax is reclaimed or becomes product cost is the
     difference between the tax being garment cost and not being garment cost,
     on every purchased line — and it is the same answer for the whole
     company. That is a governed decision with an approver and a date it takes
     effect, not a setting. See `services/board/boardPolicy.service.js`.

     Refused by NAME rather than ignored, as the other three retired families
     are: silently dropping the field would leave whoever sent it believing
     the treatment was saved, and every quotation-backed line would then be
     costed on an assumption nobody made.

     CLEARING is allowed, and only clearing: a company retiring its legacy
     value should be able to, through the screen it was set in, without that
     being a write path for a new one. */
  if (has("inputGstTreatment")) {
    const value = patch.inputGstTreatment;
    if (value === null || value === "" || value === undefined) {
      merged.inputGstTreatment = undefined;
    } else {
      throw fail(
        "GST_POLICY_MOVED",
        "Whether eligible input GST is reclaimed or included in product cost is set by the Board, with "
        + "an effective date and an approver, and is no longer part of the costing policy. This field "
        + "can only be cleared here.",
        {
          field: "inputGstTreatment",
          reason: "GST_POLICY_MOVED",
          ownedBy: "BOARD",
          policyKey: "GST_TAX_POLICY",
        },
      );
    }
  }
  /* ── LABOUR METHODOLOGY HAS MOVED, AND THIS IS NOT A SECOND WAY IN ────
     The four fields below stay on the model and on every version snapshot, so
     costings frozen under them remain explicable. What they no longer are is
     WRITABLE.

     How much of a paid month is productive, what an operator costs beyond
     take-home pay, and where machine cost sits are the three assumptions that
     decide what every minute of every operation costs — and a company at 55%
     efficiency and one at 85% have labour costs a third apart. That is a
     governed decision with an approver and a date it takes effect, not a
     setting. See `services/board/boardPolicy.service.js`.

     Refused by NAME rather than ignored, as financing and overhead are:
     silently dropping the field would leave whoever sent it believing the
     assumption was saved, and for labour that assumption is the second-largest
     number in most garment costings.

     CLEARING is allowed, and only clearing. All four clear together — they are
     one methodology, and a half-cleared one would leave an employer burden
     with no productive basis to apply it to. */
  const LABOUR_FIELDS = [
    "productiveMinutesPerMonth", "labourEfficiencyPercent",
    "employerBurdenPercent", "machineBurdenTreatment",
  ];
  for (const key of LABOUR_FIELDS) {
    if (!has(key)) continue;
    const value = patch[key];
    const clearing = value === null || value === "" || value === undefined;
    if (clearing) {
      for (const f of LABOUR_FIELDS) merged[f] = undefined;
      continue;
    }
    throw fail(
      "LABOUR_POLICY_MOVED",
      "The labour costing methodology — productive time, employer burden and machine burden — is set by "
      + "the Board, with an effective date and an approver, and is no longer part of the costing policy. "
      + "These fields can only be cleared here.",
      {
        field: key,
        reason: "LABOUR_POLICY_MOVED",
        ownedBy: "BOARD",
        policyKey: "LABOUR_METHODOLOGY",
        fields: [...LABOUR_FIELDS],
      },
    );
  }

  /* ── THE DEVELOPMENT CHARGE TABLE HAS LEFT ────────────────────────────
     What the company charges for development work it does itself is a price
     the company publishes about its own capability. It is not a rate a
     supplier quoted and not a measurement anyone took — nobody outside the
     Board can settle it — and it is now approved as `DEVELOPMENT_CHARGE_POLICY`
     with an effective date and an approver.

     The table stays on this document, and `legacyDevelopmentCharges` publishes
     it, so a costing frozen against it stays explicable and so the Board has
     the existing charges to COPY into a first draft. What it can no longer do
     is take a new one: a rate written here would price a costing without ever
     having been approved, which is the whole of what this migration removes.

     Clearing is still allowed — a company retiring what it no longer wants to
     display is not authoring policy — and the key-permanence rule follows the
     charges to the Board, where a key can be deactivated but never removed. */
  if (has("developmentCharges")) {
    const rows = patch.developmentCharges;
    const clearing = rows === null || rows === undefined
      || (Array.isArray(rows) && !rows.length);
    if (clearing) {
      merged.developmentCharges = [];
    } else {
      throw fail(
        "DEVELOPMENT_POLICY_MOVED",
        "Development and tooling charges are approved by the Board, with an effective date and an "
        + "approver, and are no longer part of the costing policy. Existing charges are kept here for "
        + "reference and can only be cleared.",
        {
          field: "developmentCharges",
          reason: "DEVELOPMENT_POLICY_MOVED",
          ownedBy: "BOARD",
          policyKey: "DEVELOPMENT_CHARGE_POLICY",
        },
      );
    }
  }

  /* ── THE MARGIN BAND AND THE PROFIT ASSUMPTIONS HAVE LEFT ─────────────
     What the company is prepared to sell for is the most consequential single
     decision on this record: the engine solves every price break from it, and
     nothing else in the family produces a NUMBER when it is absent — it
     produces a price. A band typed here would set what the company charges
     without anybody having approved it.

     Approved now as `MARGIN_POLICY`, with an effective date and an approver,
     carrying the band, the recorded approval threshold and the estimated
     income-tax rate together — the last two because they are read beside the
     band, by the same people, for the same purpose.

     All five stay on this document, and `legacy*` publishes them, so a costing
     frozen against them stays explicable and so the Board has something to
     COPY into a first draft. Clearing is still allowed; authoring is not. */
  const MARGIN_FIELDS = [
    /* The one active pricing figure. Refused here for exactly the reason the
       band was: a markup typed on this row would set what the company charges
       without anybody having approved it. */
    "floorMarkupPercent",
    "minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent",
    "approvalThresholdMarginPercent", "estimatedIncomeTaxRatePercent",
  ];
  for (const key of MARGIN_FIELDS) {
    if (!has(key)) continue;
    const value = patch[key];
    const clearing = value === null || value === "" || value === undefined;
    if (clearing) {
      /* ── THE BAND CLEARS AS A BAND ────────────────────────────────
         Clearing one of the three would leave a partial band, which is
         neither a policy nor an absence. The two optional assumptions clear
         individually, because each stands alone. */
      if (key === "approvalThresholdMarginPercent" || key === "estimatedIncomeTaxRatePercent") {
        merged[key] = undefined;
      } else {
        for (const f of ["minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent"]) {
          merged[f] = undefined;
        }
      }
      continue;
    }
    throw fail(
      "MARGIN_POLICY_MOVED",
      "The margin band, the approval threshold and the estimated income-tax rate are approved by the "
      + "Board, with an effective date and an approver, and are no longer part of the costing policy. "
      + "These fields can only be cleared here.",
      {
        field: key,
        reason: "MARGIN_POLICY_MOVED",
        ownedBy: "BOARD",
        policyKey: "MARGIN_POLICY",
        fields: [...MARGIN_FIELDS],
      },
    );
  }

  return merged;
}

/**
 * Write the company's policy.
 *
 * Company comes from the resolved context and nowhere else; the caller must
 * hold `costing.policy.manage`, which the route enforces before this runs.
 *
 * ── OPTIMISTIC CONCURRENCY, AND WHY A POLICY NEEDS IT ───────────────────────
 * The API sends the WHOLE policy back, because the screen edits it as a whole.
 * That makes a last-writer-wins update silently destructive: two people open
 * the policy at revision 4, one raises the overhead rate, the other lowers the
 * minimum margin, and whoever saves second writes their stale copy of the
 * other's field back over it. Nothing errors. Nobody notices until a costing
 * comes out wrong.
 *
 * So a write must name the revision it was composed against, and the update
 * CONDITION is `{companyId, revision}` — the database decides, not a re-read,
 * because a re-read-then-write is the same race with more steps.
 *
 * @param {object} patch  the fields to change, plus `revision`
 * @throws 409 POLICY_REVISION_CONFLICT when the policy moved underneath
 */
async function savePolicy(ctx, patch = {}) {
  const { policy: current, doc } = await getPolicy(ctx);
  const expected = patch.revision;

  if (!Number.isInteger(expected) || expected < 0) {
    throw bad(
      "A policy change must say which version of the policy it was based on.",
      { field: "revision", reason: "POLICY_REVISION_REQUIRED", currentRevision: current.revision },
    );
  }

  /* ── A LOST RACE IS DIAGNOSED BEFORE THE FORM IS ─────────────────────
     The write condition below is the actual protection and stays. But
     validating first meant a stale editor was told what was wrong with their
     FORM — "you cannot remove that charge" — when nothing was wrong with it:
     they simply had not seen the charge somebody else added. Answering the
     race first says what actually happened, and the answer is the same one
     the write condition would have given.

     The condition is still checked at the write, because the policy can move
     between this read and that write. */
  if (Number.isInteger(current.revision) && expected !== current.revision) {
    throw fail(
      "POLICY_REVISION_CONFLICT",
      "The costing policy was changed by somebody else while you were editing it. Reload it and make your change again.",
      { reason: "POLICY_REVISION_CONFLICT", expectedRevision: expected, currentRevision: current.revision },
    );
  }

  const merged = validatePatch(current, patch);

  const update = {
    companyId: ctx.companyId,
    baseCurrency: merged.baseCurrency,
    roundingMode: merged.roundingMode,
    sellingPriceIncrementMinor: merged.sellingPriceIncrementMinor,
    /* Written whole. An empty list is a company that has cleared its table,
       which is a decision and is stored as one. */
    developmentCharges: merged.developmentCharges || [],
    updatedByActorId: ctx.actorId,
    updatedByActorName: ctx.actorName || "",
  };
  /* `$unset` rather than writing undefined: clearing overhead has to remove
     the fields, or a stale rate survives with no basis to apply it to. */
  const unset = {};
  for (const [key, value] of Object.entries({
    overheadBasis: merged.overheadBasis,
    overheadRatePercent: merged.overheadRatePercent,
    /* ── THE BAND MOVED INTO THE CLEARABLE GROUP ────────────────────────
       It sat in the always-`$set` literal above, because the schema made all
       three required with a default of "0" — they could never be absent, so
       there was nothing to unset. Both of those are gone: the band is a Board
       policy now and what is left here is history, which a company must be
       able to clear. An undefined value in a `$set` is silently dropped by
       MongoDB, so leaving them there would have made clearing a no-op that
       reported success. */
    minimumMarginPercent: merged.minimumMarginPercent,
    targetMarginPercent: merged.targetMarginPercent,
    preferredMarginPercent: merged.preferredMarginPercent,
    approvalThresholdMarginPercent: merged.approvalThresholdMarginPercent,
    /* Clearable for the same reason: a company that withdraws its income-tax
       estimate wants after-tax profit to read "unavailable", not to go on
       showing a rate it no longer stands behind. */
    estimatedIncomeTaxRatePercent: merged.estimatedIncomeTaxRatePercent,
    /* The rules that were validated but never written. Same clearing
       discipline: withdrawing a financing rule has to remove both halves, or
       a stale rate survives beside a basis nobody set. */
    financingBasis: merged.financingBasis,
    financingRatePercent: merged.financingRatePercent,
    contingencyBasis: merged.contingencyBasis,
    contingencyRatePercent: merged.contingencyRatePercent,
    inputGstTreatment: merged.inputGstTreatment,
    productiveMinutesPerMonth: merged.productiveMinutesPerMonth,
    labourEfficiencyPercent: merged.labourEfficiencyPercent,
    employerBurdenPercent: merged.employerBurdenPercent,
    machineBurdenTreatment: merged.machineBurdenTreatment,
  })) {
    if (value === undefined) unset[key] = "";
    else update[key] = value;
  }

  const conflict = (found) => fail(
    "POLICY_REVISION_CONFLICT",
    "The costing policy was changed by somebody else while you were editing it. Reload it and make your change again.",
    { reason: "POLICY_REVISION_CONFLICT", expectedRevision: expected, currentRevision: found },
  );

  /* ── FIRST WRITE: AN INSERT, NOT AN UPDATE ─────────────────────────────
     Revision 0 means "there is no policy". Two people creating one at the
     same moment both see 0, so the company-unique index is what settles it —
     the loser is told the policy now exists rather than being allowed to
     overwrite the winner's. */
  if (!doc) {
    if (expected !== 0) {
      throw conflict(0);
    }
    try {
      const created = await CostingPolicy.create({ ...update, revision: 1 });
      return { policy: { ...merged, revision: created.revision }, configured: true, doc: created.toObject() };
    } catch (err) {
      if (err?.code === 11000) {
        const now = await CostingPolicy.findOne({ companyId: ctx.companyId }).select("revision").lean();
        throw conflict(now?.revision ?? 1);
      }
      throw err;
    }
  }

  const saved = await CostingPolicy.findOneAndUpdate(
    /* The revision is part of the FILTER. A stale writer matches nothing and
       changes nothing — the newer policy is never touched. */
    { companyId: ctx.companyId, revision: expected },
    {
      $set: update,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      /* Exactly once per successful change, so a snapshot can always be traced
         to the rule set it copied. */
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true },
  ).lean();

  if (!saved) {
    const now = await CostingPolicy.findOne({ companyId: ctx.companyId }).select("revision").lean();
    throw conflict(now?.revision ?? null);
  }

  return { policy: { ...merged, revision: saved.revision }, configured: true, doc: saved };
}

/**
 * Refuse to calculate for a company that has never set its rules.
 *
 * ── WHY AN UNSET POLICY IS NOT "0% MARGIN" ──────────────────────────────────
 * The defaults exist so a READ has something to return and a screen can say
 * "not set up yet". Calculating against them produced a frozen version whose
 * recommended selling price equalled its cost — a priced, immutable,
 * quotable record asserting that the company is content to sell at cost.
 * Nobody decided that. It was the absence of a decision, rendered as one.
 *
 * So a calculation is refused instead, with a code a screen can act on. An
 * explicit policy whose margins ARE zero is a different thing entirely: a
 * company that has genuinely chosen to quote at cost is allowed to, and
 * `configured` is what tells the two apart.
 */
function assertConfigured({ configured, policy } = {}) {
  if (configured) return;
  throw fail(
    "COSTING_POLICY_REQUIRED",
    "Set the company costing policy before calculating a selling price.",
    {
      reason: "COSTING_POLICY_REQUIRED",
      /* Named so a client can link straight to the screen rather than guess. */
      settingsPath: "/costing/policy",
      currentRevision: policy?.revision ?? 0,
    },
  );
}

module.exports = { DEFAULTS, getPolicy, savePolicy, validatePatch, snapshotOf, assertConfigured };
