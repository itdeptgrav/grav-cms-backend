// services/centralCosting/engine.js
//
// Central Costing — Chunk 2. THE CALCULATOR. NO DATABASE, NO REQUEST, NO CLOCK.
//
// ── WHY THIS FILE TOUCHES NOTHING ───────────────────────────────────────────
// Every number a costing produces is decided here, and a number nobody can
// re-derive is a number nobody can argue with. So this module takes plain
// objects and returns plain objects: no mongoose, no `req`, no `Date.now()`,
// no policy lookup. Given the same inputs it produces the same output forever,
// which is what makes a frozen version reproducible and a disagreement about
// cost resolvable by reading rather than by guessing.
//
// ── THE INVARIANTS IT IMPLEMENTS ────────────────────────────────────────────
// From `docs/tasks/central-costing-roadmap.md` §5, and they are load-bearing:
//
//   true cost = materials + operations + services + packaging + misc
//             + allocated fixed/setup + wastage + overhead + financing
//             + freight/duty/non-recoverable charges
//
//   floor selling price = true unit cost × (1 + markup/100)
//
// ── MARKUP ON COST, BY DECISION, AND SAID PLAINLY ───────────────────────────
// This engine solved `cost / (1 - margin)` for three price tiers until
// management replaced the model with ONE decision: a single markup percentage
// on the true cost, producing ONE floor price. The two are different
// arithmetic and the difference is money — ₹500 at 20% is ₹600 as a markup and
// ₹625 as a margin — so the change is stated here rather than left to be
// inferred from the code.
//
// Nothing converts an old margin into a markup. Versions frozen under the band
// keep their three prices and are never recomputed; new versions carry one
// floor and no band at all, so nothing downstream can find three tiers on a
// version that has one price.
//
// What did NOT change is the discipline: cost is calculated
// first and completely, and profit is applied to it afterwards — never mixed
// into the build-up.
//
// RECOVERABLE GST IS NOT COST. It is money the company gets back. It is
// computed and REPORTED (a buyer still has to fund it) and excluded from every
// cost total. Non-recoverable tax, freight, duty and financing ARE cost.
//
// QUANTITY CHANGES COST ONLY THROUGH FIXED-COST DILUTION. There are no
// supplier quantity tiers in this chunk (Chunk 3) and no efficiency curves
// (Chunk 5), so a bigger order is cheaper per piece for exactly one reason and
// the engine proves it: `variableUnitExact` is asserted identical across
// scenarios, and a mismatch is a warning, not a silent difference.
//
// MISSING IS NEVER ZERO. A line with no rate is not a free line. Every missing
// input is collected — all of them, so a caller fixes the form once — and the
// calculation is refused rather than completed with holes in it.
"use strict";

const { Decimal, dec, percent, roundMinor, ceilToIncrement } = require("./decimal");
const { SUPPORTED_CURRENCIES } = require("./money");

/* ── VOCABULARY ─────────────────────────────────────────────────────────────
 * Deliberately generic. Chunk 4 connects the BOM, SAM and operation masters;
 * until then a costing is a list of explicit lines, and a `MATERIAL` line is
 * whatever the person costing calls a material. Building the garment BOM shape
 * now, to be replaced in two chunks' time, would be building it twice. */
const CATEGORIES = Object.freeze([
  "MATERIAL",
  "OPERATION",
  "SERVICE",
  "PACKAGING",
  "MISC",
  "FIXED_SETUP",
  "WASTAGE",
  "FREIGHT",
  "DUTY",
  "NON_RECOVERABLE_TAX",
  "FINANCING",
  "OVERHEAD",
]);

/* ── PER_CARTON IS A RUN TOTAL, DECLARED HONESTLY ──────────────────────────
   A carton line is arithmetically a FIXED_PER_RUN line — the engine reads its
   `amount` / `amountByScenario` and dilutes across the run exactly the same
   way. It is a distinct value here only so the frozen line still SAYS it is a
   carton line: collapsing it to FIXED_PER_RUN before the engine would price
   it correctly and then lose, permanently, the fact that its total steps with
   the run size. Normalised to the shared arithmetic immediately below. */
const BEHAVIOURS = Object.freeze(["PER_UNIT", "PER_CARTON", "FIXED_PER_RUN", "PERCENT_OF_BASIS"]);
/** Behaviours that carry a run TOTAL rather than a per-piece rate. */
const RUN_TOTAL_BEHAVIOURS = Object.freeze(["FIXED_PER_RUN", "PER_CARTON"]);

const TAX_TREATMENTS = Object.freeze(["NONE", "RECOVERABLE", "NON_RECOVERABLE"]);

/**
 * What each percentage basis is a percentage OF, as a set of categories.
 *
 * Expressed as categories rather than as "the number above it on the screen",
 * because a costing is not a spreadsheet: reordering the lines must not change
 * the answer.
 */
const BASES = Object.freeze({
  MATERIALS: ["MATERIAL"],
  OPERATIONS: ["OPERATION"],
  SERVICES: ["SERVICE"],
  PACKAGING: ["PACKAGING"],
  PRIME: ["MATERIAL", "OPERATION"],
  CONVERSION: ["OPERATION", "SERVICE"],
  DIRECT: ["MATERIAL", "OPERATION", "SERVICE", "PACKAGING", "MISC"],
  FIXED: ["FIXED_SETUP"],
  DIRECT_PLUS_FIXED: ["MATERIAL", "OPERATION", "SERVICE", "PACKAGING", "MISC", "FIXED_SETUP"],

  /* ── THE TWO LATE SUBTOTALS, AND WHY THERE ARE EXACTLY TWO ───────────────
   * Overhead and financing are the two costs that are conventionally a
   * percentage of "everything so far". They cannot both be a percentage of the
   * same thing, because one of them comes second — so each gets a basis named
   * for what it excludes, and the exclusion is what makes it computable.
   *
   *   SUBTOTAL_BEFORE_OVERHEAD  every cost EXCEPT overhead and financing.
   *                             What overhead is charged on.
   *   SUBTOTAL_BEFORE_FINANCING every cost EXCEPT financing — so it INCLUDES
   *                             overhead. What financing is charged on, and
   *                             the reason financing can validly come after
   *                             overhead without either including itself.
   *
   * ── AND WHY `TOTAL_COST` IS GONE ────────────────────────────────────────
   * It listed every category, including the category of whatever line used it,
   * so it was circular for EVERY possible percentage line and the engine
   * refused all of them. It was not a basis with a narrow failure mode; it was
   * an option that could never once be chosen. Offering it taught callers that
   * a percentage of the total was expressible, and the honest answer is that a
   * percentage of a total that includes itself is a simultaneous equation this
   * engine deliberately does not solve. Nothing can have been stored under it
   * — every attempt was rejected — so it is removed rather than deprecated. */
  SUBTOTAL_BEFORE_OVERHEAD: CATEGORIES.filter((c) => c !== "OVERHEAD" && c !== "FINANCING"),
  SUBTOTAL_BEFORE_FINANCING: CATEGORIES.filter((c) => c !== "FINANCING"),
});

const BASIS_KEYS = Object.freeze(Object.keys(BASES));

class CostingEngineError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CostingEngineError";
    this.details = details;
  }
}

/** The engine's own version. Stored on every version it calculates, so a
 *  number can always be traced to the rules that produced it. */
const ENGINE_VERSION = 1;
const CALCULATION_SCHEMA_VERSION = 1;

const bad = (message, details) => new CostingEngineError(message, details);

/* ══════════════════════════════════════════════════════════════════════════
 * INPUT NORMALISATION
 *
 * Every problem found here is COLLECTED, not thrown one at a time: a costing
 * with six unpriced lines should tell you about six, once.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * One cost line, checked and converted into exact decimals.
 *
 * @param {object} line   as stored on a version
 * @param {string} currency the version's base currency
 * @param {object[]} missing  collected problems, appended to in place
 */
function normaliseLine(line, currency, missing, seenKeys) {
  const where = (reason, extra = {}) =>
    missing.push({ lineKey: line?.lineKey ?? null, label: line?.label ?? "", reason, ...extra });

  if (!line || typeof line !== "object") {
    throw bad("Each cost line must be an object.", { reason: "LINE_SHAPE" });
  }

  const lineKey = String(line.lineKey ?? "").trim();
  if (!lineKey) throw bad("Every cost line needs a stable key.", { reason: "LINE_KEY_REQUIRED" });
  if (seenKeys.has(lineKey)) {
    throw bad(`Two cost lines share the key "${lineKey}".`, { reason: "LINE_KEY_DUPLICATE", lineKey });
  }
  seenKeys.add(lineKey);

  if (!CATEGORIES.includes(line.category)) {
    throw bad(`"${line.category}" is not a cost category.`, {
      reason: "CATEGORY_UNKNOWN", lineKey, allowed: CATEGORIES,
    });
  }
  if (!BEHAVIOURS.includes(line.behaviour)) {
    throw bad(`"${line.behaviour}" is not a cost behaviour.`, {
      reason: "BEHAVIOUR_UNKNOWN", lineKey, allowed: BEHAVIOURS,
    });
  }

  const out = {
    lineKey,
    category: line.category,
    label: String(line.label ?? "").trim(),
    behaviour: line.behaviour,
    confidence: line.confidence === "VERIFIED" ? "VERIFIED" : "PROVISIONAL",
    /* Money the company pays and bills on at cost. Server-derived from the
       enquiry's delivery terms — the parser refuses it from a request body,
       so nobody can move a cost out of the price basis by asking. */
    recoveredSeparately: line.recoveredSeparately === true,
    sourceRef: line.sourceRef || null,
    note: String(line.note ?? "").trim(),
  };

  /* ── Tax treatment ────────────────────────────────────────────────────
     Recoverable GST is not cost (roadmap §5). It is still CARRIED, because a
     buyer has to fund it and a costing that never mentions it looks wrong to
     the person paying — it is simply never added to a cost total. */
  const treatment = line.tax?.treatment ?? "NONE";
  if (!TAX_TREATMENTS.includes(treatment)) {
    throw bad(`"${treatment}" is not a tax treatment.`, {
      reason: "TAX_TREATMENT_UNKNOWN", lineKey, allowed: TAX_TREATMENTS,
    });
  }
  out.tax = { treatment };
  if (treatment !== "NONE") {
    if (line.tax?.ratePercent === undefined || line.tax?.ratePercent === null) {
      where("TAX_RATE_MISSING", { treatment });
    } else {
      out.tax.rate = percent(line.tax.ratePercent, { field: `${lineKey}.tax.ratePercent`, min: 0, max: 100 });
    }
  }

  if (out.behaviour === "PER_UNIT") {
    /* ── WHY BOTH A RATE AND A QUANTITY, AND WHY NEITHER DEFAULTS ────────
       A material line is "₹412.50 per metre × 0.42 metres". Collapsing that
       to one per-unit figure loses the two things anybody reviewing a costing
       asks about. And `quantityPerUnit` does NOT default to 1: defaulting is
       a silent substitution, and "1" is one keystroke for a line that really
       is one-per-garment. */
    const rate = line.unitRate;
    if (!rate || rate.amountMinor === undefined || rate.amountMinor === null) {
      where("UNIT_RATE_MISSING");
    } else if (!Number.isSafeInteger(rate.amountMinor)) {
      throw bad(`The rate on "${out.label || lineKey}" is not a whole number of minor units.`, {
        reason: "AMOUNT_MINOR_UNSAFE", lineKey, value: rate.amountMinor,
      });
    } else if (rate.currency && rate.currency !== currency) {
      throw bad(`"${out.label || lineKey}" is priced in ${rate.currency}, not the costing's ${currency}.`, {
        reason: "CURRENCY_MISMATCH", lineKey, expected: currency, found: rate.currency,
      });
    } else {
      out.unitRateMinor = new Decimal(rate.amountMinor);
    }

    /* ── A RATE THAT LEGITIMATELY DIFFERS BY SCENARIO (Chunk 5A) ─────────
       A supplier quotation with quantity tiers gives a DIFFERENT rate at 500
       and at 3,000, and that is the whole economy of scale. The engine used
       to carry one rate per line and the pricing service refused the case
       outright, which made the core comparison impossible to calculate.

       `unitRateByScenario` is SERVER-DERIVED — `versionCreation` builds it by
       re-reading the quotation for each scenario's own supplier quantity. The
       parser refuses it from a request body, so a client cannot post a rate
       nobody quoted. `unitRateMinor` stays as the fallback and as what an
       old one-rate version means, so nothing that already exists changes. */
    const byScenario = line.unitRateByScenario;
    if (byScenario && typeof byScenario === "object") {
      out.unitRateByScenario = new Map();
      for (const [key, money] of Object.entries(byScenario)) {
        if (!money || money.amountMinor === undefined || money.amountMinor === null) continue;
        if (!Number.isSafeInteger(money.amountMinor)) {
          throw bad(`A scenario rate on "${out.label || lineKey}" is not a whole number of minor units.`, {
            reason: "AMOUNT_MINOR_UNSAFE", lineKey, scenarioKey: key, value: money.amountMinor,
          });
        }
        if (money.currency && money.currency !== currency) {
          throw bad(`A scenario rate on "${out.label || lineKey}" is in ${money.currency}, not the costing's ${currency}.`, {
            reason: "CURRENCY_MISMATCH", lineKey, scenarioKey: key, expected: currency, found: money.currency,
          });
        }
        out.unitRateByScenario.set(String(key), new Decimal(money.amountMinor));
      }
      if (!out.unitRateByScenario.size) out.unitRateByScenario = undefined;
    }

    if (line.quantityPerUnit === undefined || line.quantityPerUnit === null || line.quantityPerUnit === "") {
      where("QUANTITY_PER_UNIT_MISSING");
    } else {
      out.quantityPerUnit = dec(line.quantityPerUnit, {
        field: `${lineKey}.quantityPerUnit`, allowNegative: false,
      });
      out.quantityUom = String(line.quantityUom ?? "").trim();
    }
  } else if (RUN_TOTAL_BEHAVIOURS.includes(out.behaviour)) {
    const amt = line.amount;
    if (!amt || amt.amountMinor === undefined || amt.amountMinor === null) {
      where("FIXED_AMOUNT_MISSING");
    } else if (!Number.isSafeInteger(amt.amountMinor)) {
      throw bad(`The amount on "${out.label || lineKey}" is not a whole number of minor units.`, {
        reason: "AMOUNT_MINOR_UNSAFE", lineKey, value: amt.amountMinor,
      });
    } else if (amt.currency && amt.currency !== currency) {
      throw bad(`"${out.label || lineKey}" is priced in ${amt.currency}, not the costing's ${currency}.`, {
        reason: "CURRENCY_MISMATCH", lineKey, expected: currency, found: amt.currency,
      });
    } else {
      out.fixedMinor = new Decimal(amt.amountMinor);
    }

    /* ── A RUN TOTAL THAT DIFFERS BY RUN SIZE ────────────────────────────
       Most fixed lines are the same money however many pieces — a pattern
       charge, a screen. Outbound freight is not: it is charged for the RUN,
       so it is never divided into a per-garment rate and then multiplied
       back, but 1,000 garments fill more cartons than 100 do.

       `PER_KG` and `PER_CARTON` freight therefore has one run total per
       scenario, and a per-carton one does not even scale linearly — 250
       garments at 40 a carton is 7 cartons and 500 is 13, not 14. Only a
       server-derived working can produce that, which is why this mirrors
       `unitRateByScenario` exactly: built by `versionCreation` from facts it
       re-read, and refused from a request body by the parser.

       `amount` stays as the fallback and as what a version frozen before
       this means, so nothing already stored changes. */
    const fixedByScenario = line.amountByScenario;
    if (fixedByScenario && typeof fixedByScenario === "object") {
      out.fixedMinorByScenario = new Map();
      for (const [key, money] of Object.entries(fixedByScenario)) {
        if (!money || money.amountMinor === undefined || money.amountMinor === null) continue;
        if (!Number.isSafeInteger(money.amountMinor)) {
          throw bad(`A scenario amount on "${out.label || lineKey}" is not a whole number of minor units.`, {
            reason: "AMOUNT_MINOR_UNSAFE", lineKey, scenarioKey: key, value: money.amountMinor,
          });
        }
        if (money.currency && money.currency !== currency) {
          throw bad(`A scenario amount on "${out.label || lineKey}" is in ${money.currency}, not the costing's ${currency}.`, {
            reason: "CURRENCY_MISMATCH", lineKey, scenarioKey: key, expected: currency, found: money.currency,
          });
        }
        out.fixedMinorByScenario.set(String(key), new Decimal(money.amountMinor));
      }
      if (!out.fixedMinorByScenario.size) out.fixedMinorByScenario = undefined;
    }
  } else {
    if (!BASIS_KEYS.includes(line.basis)) {
      throw bad(`"${line.basis}" is not something a percentage can be taken of.`, {
        reason: "BASIS_UNKNOWN", lineKey, allowed: BASIS_KEYS,
      });
    }
    out.basis = line.basis;
    if (line.percent === undefined || line.percent === null || line.percent === "") {
      where("PERCENT_MISSING");
    } else {
      /* Up to 1000%: a financing or duty line can legitimately exceed 100% of
         a small basis, and refusing it would be inventing a business rule. */
      out.percent = percent(line.percent, { field: `${lineKey}.percent`, min: 0, max: 1000 });
    }
  }

  return out;
}

/**
 * Order the percentage lines so each is computed after everything it depends
 * on — and refuse the ones that depend on themselves.
 *
 * ── WHY A GRAPH AND NOT "JUST EVALUATE THEM LAST" ───────────────────────────
 * Overhead at 12% of SUBTOTAL_BEFORE_OVERHEAD and financing at 2% of
 * SUBTOTAL_BEFORE_FINANCING is a perfectly ordinary policy, and the second
 * depends on the first — that is exactly what the second basis is FOR, since
 * it includes overhead. Evaluating percentage lines in list order would make
 * the answer depend on how somebody typed them in. Evaluating them all against
 * a pre-percentage subtotal would silently drop the dependency.
 *
 * And a percentage of a subtotal that already contains its own category is not
 * a hard sum — it is a circular definition (overhead on a basis that includes
 * overhead). There is an algebraic fixed point, and computing it would be
 * inventing a rule nobody asked for. It is refused by name instead.
 */
function orderPercentLines(percentLines) {
  const byCategory = new Map();
  for (const l of percentLines) {
    if (!byCategory.has(l.category)) byCategory.set(l.category, []);
    byCategory.get(l.category).push(l);
  }

  const state = new Map(); // lineKey -> "VISITING" | "DONE"
  const ordered = [];

  const visit = (line, trail) => {
    const s = state.get(line.lineKey);
    if (s === "DONE") return;
    if (s === "VISITING") {
      throw bad(
        `"${line.label || line.lineKey}" is a percentage of a total that already includes it.`,
        { reason: "CIRCULAR_PERCENT_BASIS", lineKey: line.lineKey, basis: line.basis, trail: [...trail, line.lineKey] },
      );
    }
    state.set(line.lineKey, "VISITING");

    const covered = BASES[line.basis];
    /* Directly self-referential: a percentage of a basis that includes its own
       category. Caught here rather than through the trail, so the message can
       name the basis instead of a cycle. */
    if (covered.includes(line.category)) {
      throw bad(
        `"${line.label || line.lineKey}" is a percentage of a total that already includes it.`,
        { reason: "CIRCULAR_PERCENT_BASIS", lineKey: line.lineKey, basis: line.basis, category: line.category },
      );
    }
    for (const cat of covered) {
      for (const dependency of byCategory.get(cat) || []) {
        visit(dependency, [...trail, line.lineKey]);
      }
    }

    state.set(line.lineKey, "DONE");
    ordered.push(line);
  };

  for (const l of percentLines) visit(l, []);
  return ordered;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE CALCULATION
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Calculate every scenario.
 *
 * @param {object}   args
 * @param {object[]} args.lines      the explicit cost inputs
 * @param {object[]} args.scenarios  `[{key, label, quantity, isPrimary}]`
 * @param {object}   args.policy     the company policy SNAPSHOT (never looked up here)
 * @returns {{currency, scenarios, warnings, engineVersion, calculationSchemaVersion}}
 */
function calculate({ lines = [], scenarios = [], policy } = {}) {
  const warnings = [];

  /* ── 1. POLICY ────────────────────────────────────────────────────────── */
  if (!policy) throw bad("A costing cannot be calculated without a company policy.", { reason: "POLICY_REQUIRED" });
  const currency = String(policy.baseCurrency || "").toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw bad(`${currency || "(none)"} is not a currency this system can cost in.`, {
      reason: "CURRENCY_UNSUPPORTED", value: currency, supported: SUPPORTED_CURRENCIES,
    });
  }
  const roundingMode = policy.roundingMode || "HALF_UP";
  const increment = Number(policy.sellingPriceIncrementMinor ?? 1);
  if (!Number.isSafeInteger(increment) || increment < 1) {
    throw bad("The selling-price increment must be a whole number of minor units, at least 1.", {
      reason: "INCREMENT_INVALID", value: policy.sellingPriceIncrementMinor,
    });
  }

  /* ── ONE FIGURE, AND NO CEILING OF 100 ────────────────────────────────
     A margin of 100% was impossible because `cost / (1 - 1)` divides by zero.
     A markup of 100% is an ordinary doubling, and 150% is an ordinary
     commercial decision, so the only bound is that it cannot be negative — a
     floor below cost is not a floor.

     Required, and `undefined` is refused rather than defaulted: a costing
     priced at a markup nobody chose is not a price. The caller turns that
     refusal into one naming the Board — see `marginPolicy.assertApproved`. */
  const floorMarkup = percent(policy.floorMarkupPercent, {
    field: "floorMarkupPercent", min: 0, max: 100000,
  });

  /* ── 2. SCENARIOS ─────────────────────────────────────────────────────── */
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw bad("A costing needs at least one quantity to cost.", { reason: "SCENARIO_REQUIRED" });
  }
  const keys = new Set();
  const normalisedScenarios = scenarios.map((s, i) => {
    const key = String(s?.key ?? "").trim();
    if (!key) throw bad("Every quantity scenario needs a key.", { reason: "SCENARIO_KEY_REQUIRED", index: i });
    if (keys.has(key)) {
      throw bad(`Two scenarios share the key "${key}".`, { reason: "SCENARIO_KEY_DUPLICATE", key });
    }
    keys.add(key);
    const quantity = dec(s?.quantity, { field: `scenario ${key} quantity`, allowNegative: false });
    if (quantity.isZero()) {
      /* Not a rounding edge: dividing a run cost by zero pieces has no answer,
         and "0 pieces" is not a scenario anybody wants costed. */
      throw bad(`Scenario "${key}" must be for at least one piece.`, { reason: "SCENARIO_QUANTITY_ZERO", key });
    }
    return { key, label: String(s?.label ?? "").trim() || key, quantity, isPrimary: Boolean(s?.isPrimary) };
  });

  const primaryCount = normalisedScenarios.filter((s) => s.isPrimary).length;
  if (primaryCount === 0) normalisedScenarios[0].isPrimary = true;
  else if (primaryCount > 1) {
    throw bad("Only one scenario can be the primary one.", { reason: "SCENARIO_PRIMARY_AMBIGUOUS" });
  }

  /* ── 3. LINES ─────────────────────────────────────────────────────────── */
  const missing = [];
  const seenKeys = new Set();
  const normalised = lines.map((l) => normaliseLine(l, currency, missing, seenKeys));

  /* Policy overhead is a LINE, synthesised here rather than bolted on after
     the totals, so it participates in the same basis graph as every other
     percentage and appears in the breakdown as its own row. */
  const overheadRate = policy.overheadRatePercent;
  if (overheadRate !== undefined && overheadRate !== null && overheadRate !== "") {
    if (normalised.some((l) => l.category === "OVERHEAD")) {
      /* Loud rather than clever: both are included, and the reader is told,
         because silently dropping one would be a number nobody could explain
         and silently summing them would be a number nobody expected. */
      warnings.push({
        code: "OVERHEAD_DECLARED_TWICE",
        message: "This costing has its own overhead line and the company policy also applies one. Both are included.",
      });
    }
    normalised.push(normaliseLine({
      lineKey: "policy:overhead",
      category: "OVERHEAD",
      label: `Company overhead (${policy.overheadBasis})`,
      behaviour: "PERCENT_OF_BASIS",
      basis: policy.overheadBasis,
      percent: overheadRate,
      confidence: "VERIFIED",
      note: "Applied from the company costing policy snapshot.",
    }, currency, missing, seenKeys));
  }

  /* ── FINANCING IS NO LONGER ONE OF THESE ───────────────────────────────
     It used to be: a rate and a basis the company set once, applied to every
     costing. That is the shape of overhead and of contingency, and it was the
     wrong shape for the cost of money. A flat percentage of a subtotal does
     not know how long the money is out, so two orders ninety days apart in
     payment terms carried identical financing — a surcharge wearing the name
     of a cost of capital.

     Financing is now assembled per order from the Board's approved
     methodology and the payment terms Sales confirmed on the enquiry, and
     arrives here as an ordinary `PERCENT_OF_BASIS` line with its own
     provenance. It still joins the same basis graph and is still ordered
     after overhead by `SUBTOTAL_BEFORE_FINANCING`; what changed is where the
     percentage comes from.

     A company that still carries the retired `financingRatePercent` is TOLD
     rather than silently charged it — see the warning below. The field is
     read-only now (`policy.service.js` refuses it on write) and stays on the
     snapshot so versions frozen under it remain explicable. */
  if (policy.financingRatePercent !== undefined && policy.financingRatePercent !== null
    && policy.financingRatePercent !== "" && !normalised.some((l) => l.category === "FINANCING")) {
    warnings.push({
      code: "POLICY_FINANCING_RETIRED",
      message: "This company still holds an old flat financing rate. It is no longer applied — financing "
        + "is calculated from the Board's financing policy and this order's confirmed payment terms.",
    });
  }

  for (const rule of [
    { key: "contingency", category: "MISC", rate: policy.contingencyRatePercent, basis: policy.contingencyBasis, label: "Company contingency" },
  ]) {
    if (rule.rate === undefined || rule.rate === null || rule.rate === "") continue;
    if (!rule.basis) {
      /* A rate with no basis is not a rule. Reported rather than guessed at
         a default basis, which would charge it on a subtotal nobody chose. */
      warnings.push({
        code: "POLICY_RULE_INCOMPLETE",
        message: `The company ${rule.key} rate has no basis, so it was not applied.`,
      });
      continue;
    }
    normalised.push(normaliseLine({
      lineKey: `policy:${rule.key}`,
      category: rule.category,
      label: `${rule.label} (${rule.basis})`,
      behaviour: "PERCENT_OF_BASIS",
      basis: rule.basis,
      percent: rule.rate,
      confidence: "VERIFIED",
      note: "Applied from the company costing policy snapshot.",
    }, currency, missing, seenKeys));
  }

  if (normalised.length === 0) {
    throw bad("A costing needs at least one cost line.", { reason: "NO_COST_LINES" });
  }

  if (missing.length) {
    /* ── EVERY MISSING INPUT, ONCE ────────────────────────────────────────
       Not the first one. A costing with six unpriced lines should send the
       person back to the form once, not six times — and, critically, not
       produce a total with six holes filled by zero. */
    throw bad(
      `${missing.length} cost input${missing.length === 1 ? " is" : "s are"} missing a value. A missing value is not zero.`,
      { reason: "INPUTS_INCOMPLETE", missing },
    );
  }

  const perUnitLines = normalised.filter((l) => l.behaviour === "PER_UNIT");
  const fixedLines = normalised.filter((l) => RUN_TOTAL_BEHAVIOURS.includes(l.behaviour));
  const percentLines = orderPercentLines(normalised.filter((l) => l.behaviour === "PERCENT_OF_BASIS"));

  if (normalised.some((l) => l.confidence === "PROVISIONAL")) {
    warnings.push({
      code: "PROVISIONAL_INPUTS",
      message: "Some inputs are provisional: they were typed in or imported, not taken from a verified source.",
      lineKeys: normalised.filter((l) => l.confidence === "PROVISIONAL").map((l) => l.lineKey),
    });
  }

  /* ── 4. ONE SCENARIO ──────────────────────────────────────────────────── */
  const results = normalisedScenarios.map((scenario) => runScenario({
    scenario, perUnitLines, fixedLines, percentLines,
    currency, roundingMode, increment, floorMarkup,
  }));

  /* ── 5. WHY THE UNIT COST MOVED ───────────────────────────────────────── */
  const primary = results.find((r) => r.isPrimary);
  for (const r of results) {
    r.comparedToPrimary = compareToPrimary(r, primary, roundingMode);
  }

  /* Rule 9, checked rather than asserted in prose: with no supplier tiers and
     no efficiency curve in this chunk, the variable cost per piece CANNOT
     change with quantity. If it somehow did, that is a defect and the version
     says so rather than presenting the difference as an economy of scale. */
  const variableSpread = new Set(results.map((r) => r.exact.variableUnit.toFixed(10)));
  /* ── THE ONE LEGITIMATE REASON IT MAY DIFFER (Chunk 5A) ────────────────
     A supplier quotation with quantity tiers gives a different rate at 500
     and at 3,000, and the server derived both from the same dated quotation.
     That is an economy of scale with evidence behind it, not the defect this
     warning was written for — so the warning fires only when the variable
     cost moved with NO per-scenario rate to account for it. */
  const tiered = perUnitLines.some((l) => l.unitRateByScenario?.size > 1);
  if (variableSpread.size > 1 && !tiered) {
    warnings.push({
      code: "VARIABLE_UNIT_COST_VARIED",
      message: "Variable cost per piece differed between scenarios, which this chunk's rules do not permit. Treat the comparison with suspicion.",
    });
  }

  if (results.some((r) => r.roundingAdjustmentMinor !== 0)) {
    warnings.push({
      code: "ROUNDING_ADJUSTMENT",
      message: "Unit cost × quantity does not equal the total exactly; the difference is rounding and is reported per scenario.",
    });
  }

  return {
    currency,
    engineVersion: ENGINE_VERSION,
    calculationSchemaVersion: CALCULATION_SCHEMA_VERSION,
    lineCount: normalised.length,
    scenarios: results.map(publicScenario),
    warnings,
  };
}

/** One quantity, costed. All arithmetic exact until the named rounding points. */
function runScenario({ scenario, perUnitLines, fixedLines, percentLines, currency, roundingMode, increment, floorMarkup }) {
  const Q = scenario.quantity;

  const byCategoryExact = new Map(CATEGORIES.map((c) => [c, new Decimal(0)]));
  /* ── THE FIXED/VARIABLE SPLIT IS TRACKED PER CATEGORY, AS WE GO ──────────
   * Not reconstructed at the end from one overall ratio. A first cut did that
   * — split every percentage line by the fixed share of the DIRECT lines —
   * and it was wrong in a way that showed up immediately: cutting wastage is a
   * percentage of materials and therefore entirely variable, while overhead on
   * a basis that includes setup is partly fixed. Lumping them together made
   * the variable cost per piece appear to move with quantity, which this
   * chunk's rules forbid and which the engine's own check then flagged.
   *
   * Each percentage line is split by the composition of ITS OWN basis, and
   * because the lines are evaluated in dependency order the composition of
   * every basis is already known when it is needed. */
  const byCategoryFixed = new Map(CATEGORIES.map((c) => [c, new Decimal(0)]));
  const byCategoryVariable = new Map(CATEGORIES.map((c) => [c, new Decimal(0)]));
  const lineResults = [];
  let recoverableTaxExact = new Decimal(0);
  /* ── MONEY THE COMPANY PAYS AND BILLS ON SEPARATELY ────────────────────
     Prepaid freight the customer reimburses at cost. It IS a company cost —
     the money leaves — so it stays in the total and in its own category. What
     it is not is part of the GARMENT's price: marking it up would charge the
     customer a margin on their own reimbursement, and burying it in the unit
     price would bill them for it twice. So it is held aside here and taken
     out of the price basis below. */
  let recoveredExact = new Decimal(0);

  const addCategory = (cat, amount, fixedPart) => {
    byCategoryExact.set(cat, byCategoryExact.get(cat).plus(amount));
    byCategoryFixed.set(cat, byCategoryFixed.get(cat).plus(fixedPart));
    byCategoryVariable.set(cat, byCategoryVariable.get(cat).plus(amount.minus(fixedPart)));
  };

  /** Tax on a line's own cost, split by whether the company gets it back. */
  const applyTax = (line, baseExact) => {
    if (line.tax.treatment === "NONE" || !line.tax.rate) return new Decimal(0);
    const taxExact = baseExact.multipliedBy(line.tax.rate).dividedBy(100);
    if (line.tax.treatment === "RECOVERABLE") {
      /* Reported, never added: it is money the company reclaims. */
      recoverableTaxExact = recoverableTaxExact.plus(taxExact);
      return new Decimal(0);
    }
    return taxExact;
  };

  /* ── Per-unit lines: rate × consumption × quantity ─────────────────────── */
  for (const line of perUnitLines) {
    /* This scenario's own rate where the server derived one, else the line's
       single rate. Absent for a scenario is NOT zero — it falls back to the
       line rate, which is the shape every pre-Chunk-5A version has. */
    const rateForScenario = line.unitRateByScenario?.get(scenario.key) ?? line.unitRateMinor;
    const perUnitExact = rateForScenario.multipliedBy(line.quantityPerUnit);
    const runExact = perUnitExact.multipliedBy(Q);
    const taxExact = applyTax(line, runExact);
    const totalExact = runExact.plus(taxExact);
    /* Wholly variable by definition: it is charged per piece. */
    addCategory(line.category, totalExact, new Decimal(0));
    lineResults.push({
      lineKey: line.lineKey, category: line.category, label: line.label, behaviour: line.behaviour,
      confidence: line.confidence, note: line.note,
      unitRateMinor: rateForScenario.toNumber(),
      /* ── WHERE THE RATE CAME FROM, FOR THE EXPLANATION ─────────────────
         A rate table keyed by scenario can only have been built by the
         server re-reading a dated quotation: the parser refuses a
         client-supplied one outright. So its presence IS the provenance,
         and the comparison can say "supplier quotation" without relying on
         `confidence`, which this engine narrows to two values for reasons
         that predate quotation-backed lines. */
      quotationBacked: Boolean(line.unitRateByScenario),
      quantityPerUnit: line.quantityPerUnit.toFixed(),
      quantityUom: line.quantityUom || "",
      perUnitExact, totalExact, taxExact,
    });
  }

  const recover = (line, totalExact) => {
    if (line.recoveredSeparately) recoveredExact = recoveredExact.plus(totalExact);
  };

  /* ── Fixed lines: charged for the RUN, not per garment ─────────────────── */
  for (const line of fixedLines) {
    /* Usually the same money however many pieces. Freight is the exception:
       its run total is worked out per scenario from that scenario's own
       shipment — more garments is more cartons — and the scenario's own
       figure wins where the server derived one. */
    const runExact = line.fixedMinorByScenario?.get(String(scenario.key)) ?? line.fixedMinor;
    const taxExact = applyTax(line, runExact);
    const totalExact = runExact.plus(taxExact);
    /* Wholly fixed by definition: the same money however many pieces. */
    addCategory(line.category, totalExact, totalExact);
    recover(line, totalExact);
    lineResults.push({
      lineKey: line.lineKey, category: line.category, label: line.label, behaviour: line.behaviour,
      confidence: line.confidence, note: line.note,
      perUnitExact: totalExact.dividedBy(Q), totalExact, taxExact,
    });
  }

  /* ── Percentage lines, in dependency order ─────────────────────────────── */
  for (const line of percentLines) {
    const basisExact = BASES[line.basis].reduce(
      (sum, cat) => sum.plus(byCategoryExact.get(cat)), new Decimal(0),
    );
    const basisFixedExact = BASES[line.basis].reduce(
      (sum, cat) => sum.plus(byCategoryFixed.get(cat)), new Decimal(0),
    );
    const runExact = basisExact.multipliedBy(line.percent).dividedBy(100);
    const taxExact = applyTax(line, runExact);
    const totalExact = runExact.plus(taxExact);
    /* Split exactly as its own basis is split. A zero basis produces a zero
       line, so the ratio is never asked for when it would be 0/0. */
    const fixedPart = basisExact.isZero()
      ? new Decimal(0)
      : totalExact.multipliedBy(basisFixedExact).dividedBy(basisExact);
    addCategory(line.category, totalExact, fixedPart);
    lineResults.push({
      lineKey: line.lineKey, category: line.category, label: line.label, behaviour: line.behaviour,
      confidence: line.confidence, note: line.note,
      basis: line.basis, percent: line.percent.toFixed(), basisAmountExact: basisExact,
      perUnitExact: totalExact.dividedBy(Q), totalExact, taxExact,
    });
  }

  /* ── Totals ────────────────────────────────────────────────────────────── */
  const totalExact = CATEGORIES.reduce((s, c) => s.plus(byCategoryExact.get(c)), new Decimal(0));

  /* Fixed vs variable, which is the whole story of why quantity matters —
     accumulated line by line above rather than reconstructed here. */
  const fixedExact = CATEGORIES.reduce((s, c) => s.plus(byCategoryFixed.get(c)), new Decimal(0));
  const variableExact = totalExact.minus(fixedExact);

  /* ── THE TWO ROUNDING POINTS, AND ONLY THESE TWO ──────────────────────── */
  const totalCostMinor = roundMinor(totalExact, roundingMode);

  /* ── A CREDIT MAY REDUCE A COST; IT MAY NOT INVERT ONE ──────────────────
   * Individual lines are allowed to be negative — a rebate, a buyer-supplied
   * trim credited back, a correction — and refusing them would push somebody
   * into storing a sign somewhere worse. But a scenario whose credits exceed
   * its costs has no cost to price:
   *
   *     price = unit cost / (1 - margin)
   *
   * with a negative unit cost yields a negative "selling price", and the band
   * comes out ordered backwards — a recommendation to pay the buyer, presented
   * with the same confidence as a real one. It is not a rounding edge; it is a
   * costing that does not mean anything, and the honest response is to say so
   * rather than to publish it.
   *
   * Checked HERE, after the total and before any price, so no price is ever
   * derived from it. Zero is fine and stays distinct from missing: a genuinely
   * free garment is a statement somebody can make. */
  if (totalCostMinor < 0) {
    throw bad(
      `The credits on "${scenario.label || scenario.key}" come to more than its costs, so there is no cost to price.`,
      {
        reason: "NEGATIVE_NET_COST",
        scenarioKey: scenario.key,
        totalCostMinor,
        quantity: Q.toFixed(),
      },
    );
  }
  const unitCostMinor = roundMinor(totalExact.dividedBy(Q), roundingMode);
  /* Stated rather than hidden: unit × quantity will not always equal the
     total, and a reader comparing the two deserves the difference by name. */
  const roundingAdjustmentMinor = roundMinor(
    new Decimal(unitCostMinor).multipliedBy(Q).minus(totalCostMinor), roundingMode,
  );

  /* ── Selling prices: cost first, profit afterwards ─────────────────────── */
  /* ── AND SEPARATELY RECOVERED MONEY IS NOT PRICED ────────────────────
     `unitCostMinor` is what the order costs the company, all of it. The
     GARMENT's price is derived from what the garment costs — freight the
     customer reimburses at cost is billed to them once, on its own line, at
     the approved figure and with no margin on it. */
  const recoveredTotalMinor = roundMinor(recoveredExact, roundingMode);
  const recoveredPerUnitMinor = roundMinor(recoveredExact.dividedBy(Q), roundingMode);
  const pricedUnitCostMinor = unitCostMinor - recoveredPerUnitMinor;
  const unitCostExactForPrice = new Decimal(pricedUnitCostMinor);
  /* ── THE FLOOR: COST PLUS THE MARKUP MANAGEMENT APPROVED ──────────────
     `cost × (1 + m/100)`, exact, then raised to the company's saleable
     increment. Raised and never lowered: rounding a floor DOWN would publish
     a floor beneath the one management set, which is the one direction a
     floor must never move.

     Charged on `pricedUnitCostMinor` — the cost of the GARMENT — so money the
     customer reimburses separately at cost carries no markup, exactly as it
     carried no margin before. */
  const markupExact = unitCostExactForPrice
    .multipliedBy(new Decimal(100).plus(floorMarkup)).dividedBy(100);
  const floorPriceMinor = ceilToIncrement(markupExact, increment);
  const markupAmountMinor = floorPriceMinor - pricedUnitCostMinor;
  /* ── AND THE RETURN IT REALISES, WITHOUT DIVIDING BY ZERO ─────────────
     A genuinely free garment has a floor of nil, which is a legitimate
     answer and NOT an occasion to compute a percentage of nothing. Reported
     as null so a reader sees "not applicable" rather than a fabricated 0%
     or a NaN that later renders as a dash nobody can explain. */
  const realisedReturnPercent = floorPriceMinor === 0
    ? null
    : new Decimal(markupAmountMinor).dividedBy(floorPriceMinor).multipliedBy(100)
      .decimalPlaces(4).toFixed();
  const floor = {
    floorMarkupPercent: floorMarkup.toFixed(),
    calculationMethod: "MARKUP_ON_TRUE_COST",
    trueUnitCostMinor: pricedUnitCostMinor,
    markupAmountMinor,
    floorPriceMinor,
    roundingIncrementMinor: increment,
    /* What the rounding to a saleable increment actually added, said rather
       than absorbed: the difference between a price and a claim about one. */
    roundingUpliftMinor: floorPriceMinor - ceilToIncrement(markupExact, 1),
    realisedReturnOnPricePercent: realisedReturnPercent,
  };

  return {
    key: scenario.key,
    label: scenario.label,
    quantity: Q,
    isPrimary: scenario.isPrimary,
    currency,
    lineResults,
    byCategoryExact,
    totalCostMinor,
    unitCostMinor,
    roundingAdjustmentMinor,
    recoverableTaxMinor: roundMinor(recoverableTaxExact, roundingMode),
    /* Reported beside the cost rather than folded into it: a reader has to be
       able to see that the customer is billed this, at this figure, and that
       no margin was taken on it. */
    recoveredSeparatelyMinor: recoveredTotalMinor,
    recoveredSeparatelyPerUnitMinor: recoveredPerUnitMinor,
    pricedUnitCostMinor,
    fixedTotalMinor: roundMinor(fixedExact, roundingMode),
    variableTotalMinor: roundMinor(variableExact, roundingMode),
    fixedPerUnitMinor: roundMinor(fixedExact.dividedBy(Q), roundingMode),
    variablePerUnitMinor: roundMinor(variableExact.dividedBy(Q), roundingMode),
    /* ── ONE PRICE, AND NO `prices` BLOCK AT ALL ──────────────────────
       Absent, not empty. A new version that carried `prices: {}` would let a
       reader written for the band find the key, read three `undefined`s and
       render three blank tiers. Nothing here to find is the point. */
    floor,
    exact: {
      total: totalExact,
      fixed: fixedExact,
      variable: variableExact,
      fixedUnit: fixedExact.dividedBy(Q),
      variableUnit: variableExact.dividedBy(Q),
    },
  };
}

/**
 * Why this scenario's unit cost differs from the primary one.
 *
 * Decomposed rather than asserted. In this chunk the variable component MUST
 * be nil — there are no quantity tiers and no efficiency curve — so the whole
 * difference should be fixed-cost dilution plus rounding. Reporting all three
 * components means a future chunk that introduces tiers slots into the same
 * explanation instead of replacing it, and means a defect shows up as a
 * non-zero variable delta rather than as a plausible-looking number.
 */
/* ── WHAT MAY BE CALLED AN ECONOMY OF SCALE ─────────────────────────────────
 *
 * Four causes, and each is a FACT this engine can point at:
 *
 *   SUPPLIER_TIER            a supplier quoted a different rate at that
 *                            quantity, on a dated quotation, and the server
 *                            read it.
 *   FIXED_COST_DILUTION      the same fixed total divided by more pieces.
 *   UNCHANGED_VARIABLE_COST  reported so a reader can see what did NOT move.
 *                            An unexplained gap between the total delta and
 *                            the explained causes is where a wrong claim
 *                            would hide.
 *   OVERHEAD_CONSEQUENCE     overhead is a percentage of a basis that moved.
 *                            It is an arithmetic consequence, never a saving
 *                            anybody negotiated, and it says so.
 *
 * Deliberately absent: generic bulk discounts, operation efficiency, reduced
 * wastage, freight consolidation and forecast volume. Each needs a factual
 * policy or a record this chunk does not have, and presenting one as a saving
 * would put a number in front of a customer that nobody can stand behind.
 */
const EOS_CAUSES = Object.freeze([
  "SUPPLIER_TIER", "FIXED_COST_DILUTION", "UNCHANGED_VARIABLE_COST", "OVERHEAD_CONSEQUENCE",
]);

const qty = (n) => Number(n).toLocaleString("en-IN");

/**
 * Why this scenario's unit cost differs from the primary one.
 *
 * ── STRUCTURED, NOT A SENTENCE ──────────────────────────────────────────────
 * The old version returned one prose line and two lump figures. A person
 * reading "₹61 lower" cannot act on it, and cannot check it: they need to know
 * that ₹42 came from a quoted tier and ₹19 from spreading the setup, and which
 * line each belongs to. So every cause is returned with its own amounts and
 * its own provenance, and the prose is derived FROM them rather than instead
 * of them.
 */
function compareToPrimary(scenario, primary, roundingMode) {
  if (scenario.key === primary.key) return null;

  const fixedDelta = scenario.exact.fixedUnit.minus(primary.exact.fixedUnit);
  const variableDelta = scenario.exact.variableUnit.minus(primary.exact.variableUnit);
  const totalDelta = scenario.unitCostMinor - primary.unitCostMinor;
  const explained = roundMinor(fixedDelta.plus(variableDelta), roundingMode);

  const primaryLines = new Map(primary.lineResults.map((l) => [l.lineKey, l]));
  const causes = [];

  /* ── PER-LINE, BECAUSE "MATERIALS FELL" IS NOT ACTIONABLE ─────────────── */
  for (const line of scenario.lineResults) {
    const before = primaryLines.get(line.lineKey);
    if (!before) continue;
    const perUnitDelta = roundMinor(
      line.perUnitExact.minus(before.perUnitExact), roundingMode,
    );

    if (line.behaviour === "PER_UNIT") {
      const rateMoved = line.unitRateMinor !== before.unitRateMinor;
      if (rateMoved) {
        /* The ONLY way a per-piece rate may differ between scenarios in this
           chunk: the server read a different quoted tier for that scenario's
           own supplier quantity. */
        causes.push({
          cause: "SUPPLIER_TIER",
          lineKey: line.lineKey,
          category: line.category,
          label: `${line.label || line.lineKey}: supplier quantity tier`,
          primaryPerUnitMinor: roundMinor(before.perUnitExact, roundingMode),
          comparedPerUnitMinor: roundMinor(line.perUnitExact, roundingMode),
          perUnitDeltaMinor: perUnitDelta,
          primaryRateMinor: before.unitRateMinor,
          comparedRateMinor: line.unitRateMinor,
          /* Where the number came from, so it can be checked rather than
             believed. The offer identity is frozen beside it in the version's
             `offerProvenance`. */
          source: line.quotationBacked ? "SUPPLIER_QUOTATION" : "MANUAL_ENTRY",
        });
      } else if (!perUnitDelta) {
        causes.push({
          cause: "UNCHANGED_VARIABLE_COST",
          lineKey: line.lineKey,
          category: line.category,
          label: `${line.label || line.lineKey}: unchanged per garment`,
          primaryPerUnitMinor: roundMinor(before.perUnitExact, roundingMode),
          comparedPerUnitMinor: roundMinor(line.perUnitExact, roundingMode),
          perUnitDeltaMinor: 0,
          source: line.quotationBacked ? "SUPPLIER_QUOTATION" : "MANUAL_ENTRY",
        });
      }
      continue;
    }

    if (RUN_TOTAL_BEHAVIOURS.includes(line.behaviour)) {
      /* The TOTAL does not change — only how many pieces carry it. Both are
         reported, because the whole point is that nothing was negotiated. */
      causes.push({
        cause: "FIXED_COST_DILUTION",
        lineKey: line.lineKey,
        category: line.category,
        label: `${line.label || line.lineKey}: spread over ${qty(scenario.quantity)} instead of ${qty(primary.quantity)}`,
        primaryPerUnitMinor: roundMinor(before.perUnitExact, roundingMode),
        comparedPerUnitMinor: roundMinor(line.perUnitExact, roundingMode),
        perUnitDeltaMinor: perUnitDelta,
        /* Identical by construction; stated so a reader can see it is. */
        primaryTotalMinor: roundMinor(before.totalExact, roundingMode),
        comparedTotalMinor: roundMinor(line.totalExact, roundingMode),
        source: "FIXED_ALLOCATION",
      });
      continue;
    }

    if (line.behaviour === "PERCENT_OF_BASIS" && perUnitDelta !== 0) {
      causes.push({
        cause: "OVERHEAD_CONSEQUENCE",
        lineKey: line.lineKey,
        category: line.category,
        /* Named as what it is. An overhead line that moved because its basis
           moved is arithmetic, and calling it a saving would credit the
           company with a negotiation that never happened. */
        label: `${line.label || line.lineKey}: follows the basis it is charged on`,
        primaryPerUnitMinor: roundMinor(before.perUnitExact, roundingMode),
        comparedPerUnitMinor: roundMinor(line.perUnitExact, roundingMode),
        perUnitDeltaMinor: perUnitDelta,
        source: "POLICY_PERCENTAGE",
      });
    }
  }

  /* Cheapest-explanation-first is a ranking; this is not. Ordered by cause so
     two scenarios of the same costing read the same way. */
  causes.sort((a, b) => EOS_CAUSES.indexOf(a.cause) - EOS_CAUSES.indexOf(b.cause)
    || String(a.lineKey).localeCompare(String(b.lineKey)));

  const attributed = causes.reduce((n, c) => n + (c.perUnitDeltaMinor || 0), 0);

  return {
    againstScenarioKey: primary.key,
    againstQuantity: String(primary.quantity),
    unitCostDeltaMinor: totalDelta,
    fixedDilutionMinor: roundMinor(fixedDelta, roundingMode),
    variableChangeMinor: roundMinor(variableDelta, roundingMode),
    roundingMinor: totalDelta - explained,
    causes,
    /* ── THE PART NOBODY EXPLAINED ───────────────────────────────────────
       If the causes do not add up to the movement, that is said rather than
       absorbed. An unexplained residue is where a claim nobody can support
       would otherwise hide. */
    unattributedMinor: totalDelta - attributed,
    reason: fixedDelta.isNegative()
      ? "Setup and other fixed costs are spread over more pieces."
      : fixedDelta.isZero()
        ? (variableDelta.isZero()
          ? "No fixed cost to spread, so the unit cost does not change with quantity."
          : "A supplier quoted a different rate at this quantity.")
        : "Fewer pieces carry the same fixed costs.",
  };
}

/** The serialisable shape. Every `Decimal` becomes a string or an integer. */
function publicScenario(r) {
  const subtotals = [];
  for (const [category, exact] of r.byCategoryExact) {
    if (exact.isZero() && !r.lineResults.some((l) => l.category === category)) continue;
    subtotals.push({
      category,
      totalMinor: roundMinor(exact, "HALF_UP"),
      perUnitMinor: roundMinor(exact.dividedBy(r.quantity), "HALF_UP"),
    });
  }
  return {
    key: r.key,
    label: r.label,
    quantity: r.quantity.toFixed(),
    isPrimary: r.isPrimary,
    totalCostMinor: r.totalCostMinor,
    unitCostMinor: r.unitCostMinor,
    fixedTotalMinor: r.fixedTotalMinor,
    fixedPerUnitMinor: r.fixedPerUnitMinor,
    variableTotalMinor: r.variableTotalMinor,
    variablePerUnitMinor: r.variablePerUnitMinor,
    roundingAdjustmentMinor: r.roundingAdjustmentMinor,
    recoverableTaxMinor: r.recoverableTaxMinor,
    recoveredSeparatelyMinor: r.recoveredSeparatelyMinor ?? 0,
    recoveredSeparatelyPerUnitMinor: r.recoveredSeparatelyPerUnitMinor ?? 0,
    pricedUnitCostMinor: r.pricedUnitCostMinor,
    categorySubtotals: subtotals,
    lines: r.lineResults.map((l) => ({
      lineKey: l.lineKey,
      category: l.category,
      label: l.label,
      behaviour: l.behaviour,
      confidence: l.confidence,
      note: l.note,
      ...(l.unitRateMinor !== undefined ? { unitRateMinor: l.unitRateMinor } : {}),
      ...(l.quantityPerUnit !== undefined ? { quantityPerUnit: l.quantityPerUnit } : {}),
      ...(l.quantityUom ? { quantityUom: l.quantityUom } : {}),
      ...(l.basis ? { basis: l.basis, percent: l.percent, basisAmountMinor: roundMinor(l.basisAmountExact, "HALF_UP") } : {}),
      perUnitMinor: roundMinor(l.perUnitExact, "HALF_UP"),
      totalMinor: roundMinor(l.totalExact, "HALF_UP"),
      taxMinor: roundMinor(l.taxExact, "HALF_UP"),
    })),
    floor: r.floor,
    comparedToPrimary: r.comparedToPrimary,
  };
}

module.exports = {
  CATEGORIES, BEHAVIOURS, RUN_TOTAL_BEHAVIOURS, BASES, BASIS_KEYS, TAX_TREATMENTS, EOS_CAUSES,
  ENGINE_VERSION, CALCULATION_SCHEMA_VERSION,
  CostingEngineError, calculate,
};
