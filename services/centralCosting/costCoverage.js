// services/centralCosting/costCoverage.js
//
// HAVE WE ADDRESSED EVERY WAY THIS PRODUCT COSTS THE COMPANY MONEY?
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// A costing with one fabric line and nothing else produced a confident total,
// a margin and a selling price. Nothing anywhere said that packaging, freight,
// duty, financing and overhead had never been considered — the sections simply
// did not appear, and an absent section reads as "none needed" rather than
// "nobody has looked". The number was not wrong; it was answering a smaller
// question than the screen implied.
//
// ── FIVE STATES, AND FOUR OF THEM ARE ANSWERS ───────────────────────────────
// The distinction that matters is between a zero somebody PRODUCED and a zero
// nobody produced. A freight cost of nil because the customer collects is a
// result. A freight cost of nil because the field is empty is a question. They
// look identical in a total and they are not the same thing, so they are never
// stored the same way.
//
// ── AND "NOT APPLICABLE" IS SOMEBODY ELSE'S ANSWER ──────────────────────────
// Costing used to accept the decision itself: a list of `{key, reason}` on the
// calculation payload, written by whoever was costing the garment. The state
// survives — a family that genuinely does not apply is a real answer — but it
// is now READ, from the department that owns the fact, through
// `familyApplicability.service`. A family with no owner in that table has no
// escape at all, and materials, operations, overhead and labour are four of
// them.
//
// ── AND INCOME TAX IS NOT HERE ──────────────────────────────────────────────
// It sits below profit, outside product cost — see profitBridge.js. A company
// with no income-tax estimate has an incomplete PROFIT picture and a perfectly
// complete COST. Conflating them would block approving a true cost over an
// assumption that has nothing to do with what the garment costs to make.

"use strict";

/* Lazily, and for one thing only: the table of who may declare a family
   inapplicable. Required at load it would pull the Store evidence service —
   and through it a live mongoose registry — into every pure consumer of this
   file, which is most of them. */
const familyApplicability = () => require("./familyApplicability.service");

const STATE = Object.freeze({
  /* One or more valid cost lines, or an applied policy rule, produced an
     amount. */
  CALCULATED: "CALCULATED",
  /* A real line or rule produced zero. A RESULT, not a gap. */
  RECORDED_ZERO: "RECORDED_ZERO",
  /* Somebody decided it does not apply, and said why. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
  /* No cost and no decision. The only state that blocks readiness. */
  NEEDS_INPUT: "NEEDS_INPUT",
  /* The source this family was supposed to come from could not be resolved.
     Different from NEEDS_INPUT: nobody has failed to act, something failed to
     answer, and the fix is not "type a number". */
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
});

const STATE_LABEL = Object.freeze({
  CALCULATED: "Calculated",
  RECORDED_ZERO: "Recorded as nil",
  NOT_APPLICABLE: "Not applicable",
  NEEDS_INPUT: "Needs input",
  SOURCE_UNAVAILABLE: "Source unavailable",
});

/* ── THE COST FAMILIES A GARMENT COSTING MUST ANSWER ────────────────────────
 * The professional grouping, not the engine's category enum: a reader thinks
 * "freight and duty", not "FREIGHT, DUTY, NON_RECOVERABLE_TAX".
 *
 * `key` is also the key `familyApplicability` resolves a source decision
 * under, so a department answering "this style needs no packaging" answers
 * THIS packaging and not a synonym of it. */
/* ── WHO OWNS EACH COST FAMILY ──────────────────────────────────────────────
 *
 * The audit this chunk opened with. A costing is meant to be ASSEMBLED from
 * authoritative records, not retyped — so every family has to say which system
 * is supposed to answer it, and the honest answer for several of them is
 * "nothing in this repository does yet".
 *
 * Recording that is the point. A family with no source is not a gap in the
 * screen; it is a gap in the company's records, and naming its owner is what
 * turns "add a manual line" into "ask Production to configure the rate".
 *
 *   AUTOMATIC        a record exists and the assembly reads it.
 *   POLICY           the company costing policy answers it, once, for every
 *                    costing.
 *   AWAITING_SOURCE  no authoritative record exists in this repository. The
 *                    family is answerable only by a "does not apply" decision
 *                    with a reason, and it says so rather than pretending
 *                    somebody could type the figure instead.
 *
 * ── AND `PROVISIONAL_OVERRIDE` IS GONE FROM THIS LIST ───────────────────────
 * It was a fifth authority meaning "a person typed it". Nothing produces one
 * any more: no route accepts a hand-entered cost line, so no family can be in
 * that state on a costing raised from now on. Leaving the constant here would
 * be a vocabulary the engine still offers and nothing can reach, which is how
 * a retired path gets re-wired by somebody reading the enum as a menu.
 *
 * Versions frozen while it existed are unaffected — they carry the figure and
 * its `MANUAL_ENTRY` source reference, and both still read.
 *
 * A family is NOT_APPLICABLE per costing, not by definition — that is a state
 * a person puts a family into, and it lives on the assessment rather than
 * here. */
const AUTHORITY = Object.freeze({
  AUTOMATIC: "AUTOMATIC",
  POLICY: "POLICY",
  AWAITING_SOURCE: "AWAITING_SOURCE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

const FAMILIES = Object.freeze([
  {
    key: "materials", label: "Materials",
    categories: ["MATERIAL", "WASTAGE"],
    /* R&D says HOW MUCH (SampleStyle consumption, with its allowance already
       inside the measured figure); Store says WHAT IT COSTS (the supplier
       quotation register, resolved per scenario). Neither answers the other,
       and a material with a consumption and no quotation is a real, nameable
       state rather than a missing line. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "R&D and Store", system: "SampleStyle + Supplier quotations" },
    awaitingMessage: "Material has no applicable Store quotation.",
    prompt: "Fabric, trims and the wastage allowance on them.",
  },
  {
    key: "operations", label: "Production operations and labour",
    categories: ["OPERATION"],
    /* The SAM is R&D's, on the sample. The RATE is Production's, set once on
       the Operation master (`salaryDept`/`salaryDesig`) and resolved against
       average net salary — see services/operationCosting.js. An operation
       whose salary basis is unset prices at nothing, and is reported as
       missing rather than free. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "Production", system: "Operation master salary basis" },
    awaitingMessage: "Production rate has not been configured for this operation.",
    prompt: "Cutting, stitching, finishing — the conversion cost.",
  },
  {
    key: "services", label: "Outside services",
    categories: ["SERVICE"],
    /* ── IT HAS A SOURCE NOW ────────────────────────────────────────────
       It used to say "no register exists", which was true and made every
       costing answer job work with a hand-typed override. R&D or Production
       records WHAT IS REQUIRED on the technical record; Store records what a
       supplier quoted, dated, in the service quotation register. Neither
       answers the other, and a required process with no quotation is a real,
       nameable state rather than a missing line. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "R&D / Production and Store", system: "SampleStyle service requirements + Service quotations" },
    awaitingMessage: "This process has no applicable service quotation.",
    prompt: "Job work sent outside: dyeing, printing, embroidery, washing, testing.",
  },
  {
    key: "packaging", label: "Packaging",
    categories: ["PACKAGING"],
    /* ── THE MISSING LINK IS RECORDED NOW ──────────────────────────────
       Packaging items always existed in the item master and could always
       carry quotations; what was missing was the record connecting a garment
       to them. `SampleStyle.sample.packagingRequirements` is that record, so
       this reads exactly like Materials: R&D says which and how much, Store
       says what it costs. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "R&D and Store", system: "SampleStyle packaging requirements + Supplier quotations" },
    awaitingMessage: "Packaging has no applicable Store quotation.",
    prompt: "Poly bags, tags, cartons.",
  },
  {
    key: "freight", label: "Freight and logistics",
    categories: ["FREIGHT"],
    /* ── IT HAS A SOURCE NOW ────────────────────────────────────────────
       It used to say no source existed, which was true, and made every
       delivered order answerable only by a hand-typed override.

       Three desks answer it between them: Sales states who bears the
       delivery and where it goes, R&D measures what the garment ships as,
       and Store records what a transporter quoted for that lane. A customer
       who collects produces a RECORDED ZERO — an answer, not a gap.

       INBOUND freight is not this family. Freight to bring materials in is
       part of what the material cost and belongs in its rate; adding it here
       would count the same money twice. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "Sales, R&D and Store", system: "Enquiry delivery terms + shipment facts + freight quotations" },
    awaitingMessage: "Nobody has said who bears the delivery cost on this order.",
    prompt: "Delivering the finished order to the customer.",
  },
  {
    key: "duty", label: "Customs duty and non-recoverable tax",
    categories: ["DUTY", "NON_RECOVERABLE_TAX"],
    /* ── BOTH HALVES HAVE A SOURCE NOW ────────────────────────────────
       Non-recoverable GST is applied per line from the quotation and the
       Board's input-GST treatment. Customs duty is the Board's approved duty
       table, matched on the item's tariff heading and the origin Store
       recorded — so this family is no longer awaiting a source that does not
       exist.

       What remains per-line is which of the three desks has not answered, and
       `applyCustomsDuty` reports that with the owning desk named. A family
       message here would say "Finance" for a gap that is usually Store's. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "Store / Purchase and Board", system: "Sourcing evidence + the approved duty table" },
    awaitingMessage: "An imported input is missing its sourcing evidence, its tariff classification "
      + "or an approved duty rule. The line's own gap names which, and whose it is.",
    /* Recoverable input GST is NOT here: the company reclaims it, so it is
       not a cost of the product. Only tax that stays with the company is. */
    prompt: "Duty, and any indirect tax the company cannot reclaim.",
  },
  {
    key: "financing", label: "Financing",
    categories: ["FINANCING"],
    /* ── IT STOPPED BEING A COMPANY-LEVEL RULE ─────────────────────────
       It was one, and being one was the defect: a single rate applied to
       every costing cannot know how long THIS order's money is out, so two
       orders ninety days apart in payment terms carried identical financing.

       It now has two owners — the Board approves the rate and the
       methodology, Sales confirms the duration on the enquiry — and either
       can be the half that is missing. The owner named here is the Board
       because the methodology is what makes the family calculable at all;
       the per-order gap arrives from the assembly with Sales' name on it. */
    authority: AUTHORITY.POLICY,
    owner: { department: "Board", system: "Company financing policy" },
    /* Deliberately null. `policyField` looks the family up on the frozen
       policy SNAPSHOT, which still carries the retired flat rate — so a
       company that never made the Board decision would read as answered. */
    policyField: null,
    awaitingMessage: "The Board has not approved a financing policy, or this order's payment terms are not confirmed.",
    prompt: "The cost of money tied up in this order.",
  },
  {
    key: "development", label: "Development, tooling and setup",
    categories: ["FIXED_SETUP"],
    /* ── IT HAS TWO SOURCES NOW ────────────────────────────────────────
       It used to say no register existed, and offered a provisional override
       as the answer. Both are closed: R&D records WHAT SETUP IS REQUIRED on
       the technical record, and the money comes either from a supplier's own
       service quotation (work bought outside) or from the development charge
       Finance published (work the company does itself). Neither is typed
       into a costing. */
    authority: AUTHORITY.AUTOMATIC,
    owner: { department: "R&D and Store or Finance", system: "SampleStyle development requirements + Service quotations or company charges" },
    awaitingMessage: "This setup work has no applicable service quotation and no configured company charge.",
    prompt: "Pattern, marker, screens, tooling — one-time costs spread over the run.",
  },
  {
    key: "overhead", label: "Allocated company and factory overhead",
    categories: ["OVERHEAD"],
    authority: AUTHORITY.POLICY,
    /* ── THE OWNER MOVED; THE ARITHMETIC DID NOT ────────────────────────
       Still one rate on one subtotal, still synthesised by the engine as its
       own line. What changed is that the rate is now an approved,
       effective-dated Board decision rather than a field somebody could save
       — so the desk a company is sent to when it is missing is the Board's. */
    owner: { department: "Board", system: "Company overhead policy" },
    awaitingMessage: "The Board has not approved an overhead policy for this company.",
    /* Deliberately null. `policyField` looks the family up on the frozen
       SNAPSHOT, which still carries the retired flat rate — so a company that
       never made the Board decision would read as answered. */
    policyField: null,
    prompt: "Applied from the Board's approved overhead policy.",
  },
]);

const FAMILY_KEYS = Object.freeze(FAMILIES.map((f) => f.key));
const FAMILY_OF = Object.freeze(FAMILIES.reduce((acc, f) => {
  for (const c of f.categories) acc[c] = f.key;
  return acc;
}, {}));

/* Categories that belong to no family: real costs, but nothing anybody has to
   be asked about. A MISC line still appears in the build-up and the total; its
   absence is simply not a question. */
const UNGATED_CATEGORIES = Object.freeze(["MISC"]);

const FAMILY_BY_KEY = Object.freeze(FAMILIES.reduce((acc, f) => {
  acc[f.key] = f;
  return acc;
}, {}));

/**
 * WHO ANSWERS THIS COST, AND WHERE THEY RECORD IT.
 *
 * ── WHY A REFUSAL NEEDS THIS ────────────────────────────────────────────────
 * Costing no longer accepts a typed figure for anything, so every refusal it
 * raises is a redirection. "This cannot be entered here" on its own is a dead
 * end — the same dead end that sent people to type an override in the first
 * place — and the difference between a dead end and a task is the name of the
 * desk that owns the fact and the record it lives in.
 *
 * Resolved from the family where the caller named one, and from the line's
 * CATEGORY where it did not: a payload that is being refused is not a payload
 * whose own labelling can be trusted to be complete.
 *
 * Returns `null` for a category no family gates (`MISC`) and for a family
 * nobody defined — the caller then says only what it knows, rather than
 * inventing a department to send somebody to.
 */
function ownerOf({ family = "", category = "" } = {}) {
  const key = String(family || "").trim().toLowerCase()
    || FAMILY_OF[String(category || "").trim().toUpperCase()]
    || "";
  const f = FAMILY_BY_KEY[key];
  if (!f) return null;
  return {
    family: f.key,
    label: f.label,
    department: f.owner?.department || null,
    recordedIn: f.owner?.system || null,
    /* The sentence the assessment already uses for this family when it is
       outstanding, so a refusal and a coverage report say the same thing. */
    awaitingMessage: f.awaitingMessage || null,
  };
}

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * One family's state for one scenario.
 *
 * The order below is the order of authority. A family with real cost lines is
 * CALCULATED whatever anybody later decided about it — a decision cannot
 * un-cost money that was costed.
 */
function assessFamily(family, {
  subtotals = new Map(), decision = null, policySnapshot = {}, sourceFailure = null,
}) {
  const parts = family.categories
    .map((c) => subtotals.get(c))
    .filter(Boolean);

  const base = {
    key: family.key,
    label: family.label,
    categories: [...family.categories],
    /* ── WHO IS SUPPOSED TO ANSWER THIS ─────────────────────────────────
       Carried onto every assessment so a screen can say "ask Production to
       configure the rate" instead of "add a manual line" — which is the
       difference between a workflow and a blank box. */
    authority: family.authority || null,
    owner: family.owner || null,
    awaitingMessage: family.awaitingMessage || null,
    /* ── AND WHETHER ANYBODY MAY SAY IT DOES NOT APPLY ──────────────────
       Carried onto every assessment so a screen can distinguish "nobody has
       answered this yet, and Merchandising is who would" from "this family
       is required and there is no answer but a cost". The second is most of
       them, and stating it is what stops the escape being looked for. */
    applicabilityOwner: familyApplicability().APPLICABILITY_OWNER[family.key] || null,
  };

  if (parts.length) {
    const totalMinor = parts.reduce((a, p) => a + Number(p.totalMinor || 0), 0);
    const perUnitMinor = parts.reduce((a, p) => a + Number(p.perUnitMinor || 0), 0);
    /* ── A ZERO SOMEBODY PRODUCED ─────────────────────────────────────────
       A line or a policy rule was evaluated and came to nil — freight the
       customer collects, a waived charge. That is a RESULT, and recording it
       as one is the whole reason this file exists. */
    return {
      ...base,
      state: totalMinor === 0 && perUnitMinor === 0 ? STATE.RECORDED_ZERO : STATE.CALCULATED,
      totalMinor,
      perUnitMinor,
      basis: family.policyField && present(policySnapshot[family.policyField])
        ? `Company costing policy (${policySnapshot[family.policyField]}%)`
        : "Cost lines on this version",
      reason: null,
      decidedBy: null,
      decidedAt: null,
    };
  }

  /* ── SOMETHING FAILED TO ANSWER ───────────────────────────────────────────
     Not the same as nobody having acted. The only case this can currently
     detect is a policy that declares a rule which produced no line at all —
     a rate configured and no overhead in the result. Stated narrowly rather
     than sprinkled with speculative hooks: a state that fires for reasons
     nobody can name is a state nobody can act on. */
  if (sourceFailure) {
    return {
      ...base,
      state: STATE.SOURCE_UNAVAILABLE,
      totalMinor: null,
      perUnitMinor: null,
      basis: sourceFailure.basis || null,
      reason: sourceFailure.reason,
      decidedBy: null,
      decidedAt: null,
    };
  }

  /* ── SOMEBODY WHO OWNS THE FACT SAID IT DOES NOT APPLY ────────────────────
     Read from their record, never sent with the calculation. The basis names
     WHICH record answered — "Merchandising recorded that this style needs no
     packaging" is checkable; "marked not applicable on this version", which is
     what this used to say, was not. */
  if (decision) {
    return {
      ...base,
      state: STATE.NOT_APPLICABLE,
      /* Null, not 0. A family nobody is charging for has no amount; writing
         zero would put it in a total as though it had been costed. */
      totalMinor: null,
      perUnitMinor: null,
      basis: decision.basis || "Recorded by the department that owns it",
      /* Their judgement, with their author. Never a verified fact. */
      reason: decision.reason,
      decidedBy: decision.decidedByName || decision.decidedByActorId || null,
      decidedAt: decision.decidedAt || null,
      decidedIn: decision.recordedIn || null,
      decidedByDepartment: decision.ownerDepartment || null,
    };
  }

  return {
    ...base,
    state: STATE.NEEDS_INPUT,
    totalMinor: null,
    perUnitMinor: null,
    basis: null,
    reason: family.prompt,
    decidedBy: null,
    decidedAt: null,
  };
}

/**
 * The whole coverage assessment for one scenario.
 *
 * SERVER-DERIVED, always. The browser may preview the same arithmetic, but a
 * costing that could declare itself complete is a costing whose completeness
 * means nothing.
 */
function assess({ scenario = {}, policySnapshot = {}, sourceDecisions = {}, warnings = [] } = {}) {
  const subtotals = new Map(
    (scenario.categorySubtotals || []).map((s) => [s.category, s]),
  );
  /* ── A DECISION ON A FAMILY NOBODY MAY EXCUSE IS DROPPED ──────────────────
     Second layer. The resolver produces none for materials, operations,
     overhead, freight or financing — but a future caller, or a resolver
     changed without this file, would otherwise be able to excuse a family that
     is inherently required. Filtered by the SAME table that decides who may
     answer, so the two cannot disagree. */
  const decided = new Map(
    Object.entries(sourceDecisions || {})
      .filter(([key, value]) => value && familyApplicability().canBeInapplicable(key))
      .map(([key, value]) => [key, value]),
  );

  /* The one genuine source failure this can detect today. */
  /* Whether THIS version was calculated with an overhead rule — read from the
     snapshot, which is what it was calculated with whether the rule came from
     the Board or from the flat rate that preceded it. */
  const overheadDeclared = present(policySnapshot.overheadRatePercent);
  const overheadProduced = subtotals.has("OVERHEAD");

  const families = FAMILIES.map((f) => assessFamily(f, {
    subtotals,
    decision: decided.get(f.key) || null,
    policySnapshot,
    sourceFailure: f.key === "overhead" && overheadDeclared && !overheadProduced
      ? {
        reason: "The company policy declares an overhead rate, but no overhead was applied to this version.",
        basis: `Company costing policy (${policySnapshot.overheadRatePercent}%)`,
      }
      : null,
  }));

  /* Costs that belong to no family — real, included in the total, and not
     something anybody has to be asked about. Listed so the panel can show the
     whole cost rather than only the gated part of it. */
  const ungated = UNGATED_CATEGORIES
    .map((c) => subtotals.get(c))
    .filter(Boolean)
    .map((s) => ({
      category: s.category,
      totalMinor: Number(s.totalMinor || 0),
      perUnitMinor: Number(s.perUnitMinor || 0),
    }));

  const outstanding = families.filter(
    (f) => f.state === STATE.NEEDS_INPUT || f.state === STATE.SOURCE_UNAVAILABLE,
  );

  return {
    scenarioKey: scenario.key,
    families,
    ungated,
    /* ── THE ONE BOOLEAN ──────────────────────────────────────────────────
       Every family answered, one way or another. A family in NEEDS_INPUT or
       SOURCE_UNAVAILABLE is an unanswered question, and a total that omits an
       unanswered question is not a total. */
    costComplete: outstanding.length === 0,
    outstanding: outstanding.map((f) => ({ key: f.key, label: f.label, state: f.state, reason: f.reason })),
    /* Carried so a reader can tell an assessment made by an old engine from
       one made by this one. */
    warnings: (warnings || []).map((w) => w.code).filter(Boolean),
  };
}

/**
 * The four readiness answers, which are deliberately separate.
 *
 * A costing can have a perfectly complete COST and no selling price at all;
 * that is a normal state, not a fault. Collapsing them into one "ready" flag
 * is what makes a screen unable to say which of the two is missing.
 */
function readiness({ completeness = null, scenarios = [], commercial = null } = {}) {
  const priced = new Set(
    (commercial?.proposedPrices || []).map((p) => p.scenarioKey),
  );
  const taxRateConfigured = present(commercial?.estimatedIncomeTaxRatePercent);
  const total = scenarios.length;

  const costComplete = completeness ? completeness.costComplete === true : null;

  return {
    cost: {
      /* Null, not false, when nothing was recorded — a legacy version was not
         assessed, which is different from having been assessed and failed. */
      ready: costComplete,
      outstanding: completeness?.outstanding || [],
      recorded: Boolean(completeness),
    },
    selling: {
      ready: total > 0 && priced.size === total,
      priced: priced.size,
      total,
      unpriced: scenarios.filter((s) => !priced.has(s.key)).map((s) => s.key),
    },
    afterTax: {
      /* Needs all three. A missing tax rate makes only THIS unavailable — it
         does not make the product cost incomplete. */
      ready: costComplete === true && total > 0 && priced.size === total && taxRateConfigured,
      taxRateConfigured,
      available: taxRateConfigured ? priced.size : 0,
      total,
    },
    approval: {
      /* Income tax is deliberately absent from this. A true cost does not
         become unapprovable because nobody has estimated the company's tax
         rate — that assumption has nothing to do with what the garment costs
         to make. */
      ready: costComplete === true,
      blockedBy: costComplete === true ? [] : (completeness?.outstanding || []),
      recorded: Boolean(completeness),
    },
  };
}

module.exports = {
  AUTHORITY,
  STATE, STATE_LABEL, FAMILIES, FAMILY_KEYS, FAMILY_OF, UNGATED_CATEGORIES,
  assess, assessFamily, readiness, ownerOf,
};
