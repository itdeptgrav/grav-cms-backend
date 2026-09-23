// services/centralCosting/sourceApps.js
//
// LANE B — WHICH DEPARTMENT OWES COSTING WHICH FACT, AND IN WHOSE APP.
//
// ── THE PRODUCT DECISION THIS ENCODES ───────────────────────────────────────
// No operational user will work inside Central Costing. It is a calculation,
// validation, versioning and audit engine, and its screens are temporary. So
// a missing input must be surfaced where the person who owns it already works
// — on the Style or the Enquiry, inside their own department's app — and never
// as a queue in a costing workspace they have no reason to open.
//
// `inputReadiness.js` answers the costing-side question: given a FROZEN
// version, what did each family end up as. This answers the other direction:
// given a LIVE style or enquiry, what does MY department still owe, why does
// costing need it, and where do I enter it.
//
// The two share their family keys deliberately, so a fact named here is the
// same fact `costCoverage.js` assessed there. They are not the same object and
// neither derives from the other: one reads a frozen record, the other reads
// today's.
//
// ── WHAT A DEPARTMENT MAY BE TOLD ───────────────────────────────────────────
// Its own missing fact, why costing needs it, where it is entered, and whether
// somebody else is holding it up — by DEPARTMENT NAME only.
//
// Never: a supplier's rate, a quotation reference, a policy value, a margin, a
// calculated cost, or another department's evidence. Store owning a quotation
// does not make R&D entitled to read it, and a "waiting on Store" line that
// carried the quoted rate would be exactly that leak wearing a status label.
// The projection service enforces it; this file simply never describes one.
//
// ── AND PACKAGING IS NOT HERE ───────────────────────────────────────────────
// Lane A owns it end to end — the Merchandising selection, R&D's consumption,
// `PER_CARTON`, and the BOM → Packaging section being built for it. This file
// names no packaging fact, and `sample.shipment.garmentsPerCarton` in
// particular is Lane A's to surface: it is the carton capacity, shared between
// packaging and freight, and restating it here would put two screens in charge
// of one field.
"use strict";

/** The apps a Costing input can belong to. One owner per fact, never two. */
const SOURCE_APP = Object.freeze({
  MERCHANDISING: "MERCHANDISING",
  RND: "RND",
  PRODUCTION: "PRODUCTION",
  SALES: "SALES",
  STORE: "STORE",
  /* Company policy only. No operational screen exists for it yet, and this
     task deliberately does not build one. */
  BOARD: "BOARD",
});

/**
 * The department grant that proves somebody works in that app.
 *
 * `models/Access/DepartmentRole.js` slugs, resolved through
 * `services/departmentRoles.js` — the same guard every other departmental
 * screen in this repository uses. No second permission vocabulary.
 *
 * `viewer` is enough to READ a requirements panel: it says what is missing and
 * carries no rate, no policy value and no cost. Entering the fact is gated by
 * the form's own guard, which is unchanged and stricter.
 */
const APP_GRANT = Object.freeze({
  MERCHANDISING: { departmentSlug: "merchandiser", minimumRole: "viewer" },
  RND: { departmentSlug: "research-development", minimumRole: "viewer" },
  PRODUCTION: { departmentSlug: "project-manager", minimumRole: "viewer" },
  SALES: { departmentSlug: "sales", minimumRole: "viewer" },
  STORE: { departmentSlug: "store", minimumRole: "viewer" },
  /* No Board app exists. Nobody holds this grant, so nobody is served a Board
     requirement list — the blocker still SHOWS on the family that is stuck on
     it, named and unactionable, which is the honest state. */
  BOARD: { departmentSlug: "board", minimumRole: "viewer" },
});

/** What subject a requirement is asked about. */
const SUBJECT = Object.freeze({ STYLE: "STYLE", ENQUIRY: "ENQUIRY" });

/* ── THE SIX STATES ─────────────────────────────────────────────────────────
 *
 * `not_started` and `in_progress` are different answers and are worth the
 * extra state: a person who has entered half a technical record needs to be
 * told they are half way, not that they have not begun.
 *
 * `awaiting_other_department` is the one that keeps a department from chasing
 * its own tail. R&D cannot record a consumption for a material Merchandising
 * has not chosen, and telling R&D "missing" would send them to a form that
 * cannot accept the answer.
 *
 * `blocked` is for a fact with no form to enter it in — a gap in the company's
 * records, not in somebody's work. It never offers an action, because there is
 * none, and inventing one is how a placeholder link gets shipped.
 */
const STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  AWAITING_OTHER_DEPARTMENT: "awaiting_other_department",
  BLOCKED: "blocked",
  READY: "ready",
  NOT_APPLICABLE: "not_applicable",
});

const STATUS_LABEL = Object.freeze({
  not_started: "Not started",
  in_progress: "In progress",
  awaiting_other_department: "Waiting on another department",
  blocked: "Blocked — no place to record this yet",
  ready: "Ready",
  not_applicable: "Not applicable",
});

/** The states that stop Central Costing calculating. */
const BLOCKING_STATUSES = Object.freeze([
  STATUS.NOT_STARTED, STATUS.IN_PROGRESS,
  STATUS.AWAITING_OTHER_DEPARTMENT, STATUS.BLOCKED,
]);

/* ── DOES A FORM EXIST TO ENTER THIS IN? ────────────────────────────────────
 * `PRESENT` — a real screen in the owning app accepts it today, named by
 *   `action`. `MISSING` — no screen does, so the requirement carries a typed
 *   blocker and NO action. A link to a screen that cannot take the answer is
 *   worse than none: it reads as the form being broken rather than absent. */
const SOURCE_FORM = Object.freeze({ PRESENT: "PRESENT", MISSING: "MISSING" });

/** Typed blocker codes. Stable strings a client may branch on. */
const BLOCKER = Object.freeze({
  /* The owning app has no form for this fact yet. */
  SOURCE_FORM_MISSING: "SOURCE_FORM_MISSING",
  /* The company has no record of this KIND at all — not a missing form, a
     missing contract. Customs classification is the standing example. */
  SOURCE_CONTRACT_MISSING: "SOURCE_CONTRACT_MISSING",
  /* A company policy the Board owns is not in force. Named, never valued. */
  BOARD_POLICY_REQUIRED: "BOARD_POLICY_REQUIRED",
});

/**
 * A LOCAL action — a section of the screen the panel is already on.
 *
 * Never a URL, and never `/costing`. The panel resolves the id against its own
 * page, so "go to input" is a scroll or a tab within the app the person is
 * already in. A cross-app link would be the costing workspace's dead end moved
 * to a new address.
 */
const action = (id, label, section) => Object.freeze({ id, label, section });

/* ── WHAT A REQUIREMENT IS A PREREQUISITE *FOR* ─────────────────────────────
 *
 * Every requirement here used to feed a cost FAMILY — a consumption feeds
 * materials, a lane feeds freight — and the projection filtered and grouped on
 * that. It was the only shape there was, so it was the shape everything took.
 *
 * The confirmed Sales costing brief is not one of those. It does not feed a
 * family; it is the thing that says a costing should exist at all, and without
 * it there is no style, no run size and no unit for ANY family to be priced
 * at. Giving it a family would invent a cost that never appears in a build-up,
 * which is exactly the artificial attachment this distinction avoids.
 *
 *   FAMILY       this fact feeds one named cost family.
 *   CALCULATION  the calculation cannot begin without it, whatever the
 *                families would otherwise be able to answer.
 *
 * A CALCULATION requirement carries `family: null`, and every consumer that
 * groups by family skips it rather than bucketing it somewhere false. */
const SCOPE = Object.freeze({ FAMILY: "FAMILY", CALCULATION: "CALCULATION" });

const req = (r) => Object.freeze({
  waitingOn: null, blocker: null, action: null, subject: SUBJECT.STYLE,
  sourceForm: SOURCE_FORM.PRESENT, scope: SCOPE.FAMILY, family: null, ...r,
});

/* ══ THE REQUIREMENTS ══════════════════════════════════════════════════════
 *
 * `family` is the `costCoverage.js` family this fact feeds, so a person can be
 * told which cost is stuck without being shown the cost.
 *
 * `why` is written for the person who has to act, not for the engine. "Costing
 * cannot price a material nobody has measured" is a reason; "MATERIAL_
 * CONSUMPTION is required" is a field name. */
const REQUIREMENTS = Object.freeze([

  /* ── MERCHANDISING ─────────────────────────────────────────────────── */
  req({
    key: "MATERIAL_BOM_IDENTITY",
    family: "materials",
    sourceApp: SOURCE_APP.MERCHANDISING,
    label: "Which materials this style is made of",
    why: "Costing prices what the bill of materials names. Until the components are chosen "
      + "there is nothing for R&D to measure and nothing for Store to quote.",
    action: action("MERCH_BOM", "Open the bill of materials", "bom"),
  }),
  req({
    key: "DEVELOPMENT_REQUIREMENT_IDENTITY",
    family: "development",
    sourceApp: SOURCE_APP.MERCHANDISING,
    label: "Whether this style needs development, pattern or tooling work",
    why: "One-time setup is spread across the run, so costing has to know it is needed before "
      + "it can be priced or excluded.",
    /* ── AND IT HAS A FORM NOW ───────────────────────────────────────
       The Development section of the Merchandising Style BOM. It writes the
       `DEVELOPMENT_TOOLING` half of `sample.serviceRequirements[]` — the
       same record the costing already reads — and names the configured
       charge type or the registered service. No amount, and no rate. */
    action: action("MERCH_STYLE_DEVELOPMENT", "Open the Development section", "development"),
  }),

  /* ── R&D ───────────────────────────────────────────────────────────── */
  req({
    key: "MATERIAL_CONSUMPTION",
    family: "materials",
    sourceApp: SOURCE_APP.RND,
    label: "How much of each material one garment uses",
    why: "A rate without a consumption prices nothing. The allowance belongs here too, stated "
      + "separately so nothing multiplies it in twice.",
    action: action("RND_TECHNICAL_MATERIALS", "Open the technical record", "technical-materials"),
  }),
  req({
    key: "TECHNICAL_SPECIFICATION",
    family: "materials",
    sourceApp: SOURCE_APP.RND,
    label: "The technical record submitted and approved",
    why: "Costing reads an approved revision. A draft can still change under a costing that "
      + "has already been calculated from it.",
    action: action("RND_TECHNICAL_SUBMIT", "Open the technical record", "technical-materials"),
  }),
  req({
    key: "SHIPMENT_PACKED_WEIGHT",
    family: "freight",
    sourceApp: SOURCE_APP.RND,
    label: "What one packed garment weighs",
    why: "Freight is quoted by weight on most lanes. Packed, not net — the carrier bills for "
      + "what leaves the building.",
    action: action("RND_SHIPMENT", "Open the shipment facts", "shipment"),
  }),

  /* ── PRODUCTION ────────────────────────────────────────────────────── */
  req({
    key: "OPERATION_ROUTE_AND_SAM",
    family: "operations",
    sourceApp: SOURCE_APP.PRODUCTION,
    label: "The operations this style goes through, and how long each takes",
    why: "Conversion cost is time × the company's labour rate. An unrouted style prices its "
      + "labour at nothing.",
    /* ── IT HAS A SCREEN NOW ──────────────────────────────────────────
       The Route & SAM section on the product workspace. The RECORD did not
       move — `techSheet.technical.operations[]` is still the one stored
       route — but the door did: R&D's writer refuses operations, and
       Production has its own narrow one. No Journey, and no destination
       anywhere near a costing screen: Production reaches it from a Product,
       which is where their work begins. */
    action: action("PM_STYLE_ROUTE", "Open Route & SAM", "route-and-sam"),
  }),
  req({
    key: "OPERATION_SALARY_BASIS",
    family: "operations",
    sourceApp: SOURCE_APP.PRODUCTION,
    label: "The salary basis each registered operation is costed against",
    why: "An operation with no department and designation resolves to no rate, and its labour "
      + "is reported as missing rather than free.",
    /* The operation master IS a Production screen, and it exists. It is not
       style-scoped, which is correct: a salary basis is a master fact. */
    action: action("OPERATION_MASTER", "Open the operation master", "operations-master"),
  }),
  req({
    key: "OUTSIDE_PROCESS_REQUIREMENT",
    family: "services",
    sourceApp: SOURCE_APP.PRODUCTION,
    label: "Whether any process is sent outside",
    why: "Dyeing, printing, washing and testing are bought, not made. Costing needs to know "
      + "they are required before Store can quote them.",
    action: action("PM_OUTSIDE_PROCESSES", "Open outside processes", "outside-processes"),
  }),

  /* ── SALES ─────────────────────────────────────────────────────────── */
  req({
    key: "FREIGHT_ARRANGEMENT",
    family: "freight",
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.SALES,
    label: "Who bears the delivery on this order",
    why: "Whether the customer collects or the company delivers changes the garment cost by the "
      + "whole freight amount. It is never assumed, and never priced at nil while unanswered.",
    action: action("SALES_DELIVERY_TERMS", "Open the delivery terms", "delivery-terms"),
  }),
  req({
    key: "FREIGHT_DESTINATION",
    family: "freight",
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.SALES,
    label: "Where this order ships to",
    why: "A freight rate is quoted for a lane. Billing and shipping addresses are separate "
      + "records precisely because they differ, so nothing substitutes one for the other.",
    action: action("SALES_DELIVERY_TERMS", "Open the delivery terms", "delivery-terms"),
  }),
  req({
    key: "FREIGHT_RECOVERY_DECISION",
    family: "freight",
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.SALES,
    label: "Whether prepaid freight is inside the price or billed on",
    why: "\"Prepaid\" says the company pays the carrier and says nothing about recovering it. "
      + "The two readings differ by the whole freight amount.",
    action: action("SALES_DELIVERY_TERMS", "Open the delivery terms", "delivery-terms"),
  }),
  /* ── AND WHAT SALES ASKED TO BE COSTED AT ALL ──────────────────────
     A CALCULATION prerequisite, not a family input: without a confirmed
     brief there is no style, no run size and no unit for any family to be
     priced at. It is listed first among Sales' requirements because it is
     the one that gates the rest.

     Its subject is the ENQUIRY. A brief belongs to an enquiry product, and
     one of the states it must be able to report — "the style you chose is no
     longer eligible" — is precisely a state where the style is the wrong
     thing to hang the question on. */
  req({
    key: "SALES_COSTING_BRIEF",
    scope: SCOPE.CALCULATION,
    family: null,
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.SALES,
    label: "What this product is being costed for",
    why: "Central Costing prices what somebody asked for. Which approved style is quoted, at "
      + "what quantities and in what unit are commercial decisions, and nothing can be "
      + "calculated until they are confirmed.",
    action: action("SALES_COSTING_BRIEF", "Open the costing brief", "costing-brief"),
  }),
  req({
    key: "PAYMENT_TERMS_DURATION",
    family: "financing",
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.SALES,
    label: "How long this order's money is out",
    why: "The financing rate says what money costs. Without a duration there is nothing to "
      + "apply it to, and a percentage of a subtotal is not a cost of capital.",
    /* ── AND SALES HAS A FORM FOR IT NOW ─────────────────────────────
       Structured terms on the enquiry — the advance, how long the balance
       runs, and what it runs from — confirmed by a person and copied from
       the Account's standing terms rather than read through them.

       ── WHAT IS STILL MISSING IS NOT SALES' ──────────────────────────
       The rate and the METHODOLOGY that turn a duration into a cost of
       capital are the Board's. So this requirement can reach READY while
       the `financing` FAMILY stays blocked on `FINANCING_POLICY` (§12).
       Two blockers, two owners, deliberately not collapsed. */
    action: action("SALES_PAYMENT_TERMS", "Open the payment terms", "payment-terms"),
  }),

  /* ── STORE ─────────────────────────────────────────────────────────── */
  req({
    key: "MATERIAL_QUOTATION",
    family: "materials",
    sourceApp: SOURCE_APP.STORE,
    label: "A dated supplier quotation for each material",
    why: "A costing is assembled from the register, not from a figure somebody typed. A material "
      + "with no applicable quotation refuses the whole calculation rather than costing as zero.",
    action: action("STORE_MATERIAL_QUOTATIONS", "Open the supplier quotation register", "materials"),
  }),
  req({
    key: "SERVICE_QUOTATION",
    family: "services",
    sourceApp: SOURCE_APP.STORE,
    label: "A dated service quotation for each outside process",
    why: "Job work is priced from the service register, dated and referenced, for the same reason "
      + "materials are.",
    action: action("STORE_SERVICE_QUOTATIONS", "Open the service quotation register", "services"),
  }),
  req({
    key: "FREIGHT_QUOTATION",
    family: "freight",
    subject: SUBJECT.ENQUIRY,
    sourceApp: SOURCE_APP.STORE,
    label: "A dated transporter quotation for this lane",
    why: "A freight rate belongs to an origin, a destination and a mode. Road and air on one "
      + "lane are different rates and different transporters.",
    action: action("STORE_FREIGHT_QUOTATIONS", "Open the freight quotation register", "freight"),
  }),
  req({
    key: "SOURCING_ORIGIN_EVIDENCE",
    family: "duty",
    sourceApp: SOURCE_APP.STORE,
    label: "Where purchased goods originate, and how they are classified for import",
    why: "Customs duty cannot be worked out without a tariff heading and a country of origin. "
      + "An absent classification is never read as duty-free.",
    /* ── AND STORE HAS A FORM FOR IT NOW ─────────────────────────────
       Sourcing type and country of origin on the supplier quotation, where
       they can vary between offers and inherit the quotation's own
       provenance and validity; the customs tariff classification on the item
       master, where it belongs to the goods.

       ── WHAT IS STILL MISSING IS NOT STORE'S ─────────────────────────
       The table that turns a heading and an origin into a duty rate is the
       Board's, and it does not exist. So this requirement can reach READY —
       the facts are recorded — while the `duty` FAMILY stays blocked on
       `DUTY_POLICY` (§12). Those are two different blockers with two
       different owners, and collapsing them would tell Store to fix
       something they cannot. */
    action: action("STORE_MATERIAL_QUOTATIONS", "Open the supplier quotation register", "materials"),
  }),
]);

/* ══ BOARD POLICY ══════════════════════════════════════════════════════════
 *
 * ── WHY THESE ARE NOT REQUIREMENTS ABOVE ────────────────────────────────────
 * A requirement above is a fact about THIS style or THIS enquiry. A policy is a
 * company fact that every costing reads, and it is not entered per order. It
 * blocks the same families, so it is reported alongside them — as a named,
 * unactionable blocker, never as a field somebody could fill in from a costing.
 *
 * ── AND THE VALUES ARE NEVER PUBLISHED ──────────────────────────────────────
 * The projection reports whether a policy is IN FORCE. Not the rate, not the
 * band, not the threshold. A merchandiser learning the company's overhead
 * percentage from a readiness panel is the leak this whole boundary exists to
 * prevent, and "configured: true" is the entire answer anybody outside Finance
 * or the Board needs.
 *
 * ── THE LIFECYCLE THIS TASK DOES NOT BUILD ─────────────────────────────────
 *   draft → Board-approved → effective-dated → superseded
 *
 * A policy is drafted, approved by the Board as a body, comes into force on a
 * stated date, and is SUPERSEDED rather than edited. `CostingPolicy` today has
 * a `revision` counter and no approval and no effective dating, so "the policy
 * as it stood in March" is reconstructible only through the snapshot each
 * frozen version already carries.
 *
 * That snapshot is why old versions stay correct through all of this: a frozen
 * `CostingVersion` resolved its policy once and kept a copy. Publishing a new
 * policy version, superseding an old one, or backdating an effective date
 * cannot restate a costing that has already been calculated — and the Board
 * lifecycle must preserve that property rather than replace it with a live
 * lookup.
 */
const BOARD_POLICIES = Object.freeze([
  {
    key: "OVERHEAD_POLICY", policyName: "Company and factory overhead",
    families: ["overhead"],
    /* ── THE SECOND POLICY WITH A REAL BOARD RECORD ─────────────────────
       Approved, effective-dated and superseded rather than overwritten, like
       financing. `policyField` is null deliberately: the retired
       `CostingPolicy.overheadRatePercent` must not make this read as answered.
       A company still holding the old flat rate has not made the Board
       decision; it has a number nobody approved. */
    policyField: null,
    boardPolicyKey: "OVERHEAD",
    why: "What the company adds to every garment to cover what it costs to run — the rate, and the "
      + "costing subtotal it applies to. Without it the garment carries none of that overhead, and "
      + "unset is unset; it never becomes nil.",
  },
  {
    key: "FINANCING_POLICY", policyName: "Cost of financing",
    families: ["financing"],
    /* ── THE FIRST POLICY THAT ACTUALLY HAS A BOARD RECORD ──────────────
       The rest of this list is still answered by "is there a value on
       `CostingPolicy`", which can say whether a field is filled in and
       nothing about whether anybody approved it or from when. Financing is
       answered by a `BoardPolicy` version instead — approved, effective-dated
       and superseded rather than overwritten — so this entry reports a real
       effective date where the others report that they cannot.

       `policyField` is deliberately null: the retired
       `CostingPolicy.financingRatePercent` must not make this read as
       answered. A company holding the old flat rate has not made the Board
       decision; it has a number nobody approved. */
    policyField: null,
    boardPolicyKey: "FINANCING",
    why: "What money costs the company and how a payment duration becomes a figure — the rate, what "
      + "period it covers, which subtotal it applies to, and whether the advance reduces the financed "
      + "amount. Unset is unset; it never becomes nil.",
  },
  {
    key: "LABOUR_METHODOLOGY", policyName: "Labour costing methodology",
    families: ["operations"],
    /* ── THE THIRD POLICY WITH A REAL BOARD RECORD ──────────────────────
       `policyField` is null deliberately: the retired
       `CostingPolicy.labourEfficiencyPercent` must not make this read as
       answered. A company still holding the old assumptions has not made the
       Board decision; it has three numbers nobody approved. */
    policyField: null,
    boardPolicyKey: "LABOUR_METHODOLOGY",
    why: "A minute of SAM is not a minute of paid time, and an operator does not cost their "
      + "take-home pay. How much of a paid month is productive, what the employer burden adds, "
      + "and where machine cost sits are three company decisions — and without them the "
      + "conversion cost is understated by a third or more.",
  },
  {
    key: "GST_TAX_POLICY", policyName: "Input GST treatment",
    /* ── STILL THE `duty` FAMILY, AND STILL NOT CUSTOMS DUTY ────────────
       Costing reports duty and non-recoverable tax under one family because
       both are "tax that stays with the company". They are different charges
       on different events with different sources, and this policy answers
       only the second — `DUTY_POLICY` below is the other, and it still has no
       record at all. */
    families: ["duty"],
    /* Null deliberately: the retired `CostingPolicy.inputGstTreatment` must
       not make this read as answered. A company holding the old value has not
       made the Board decision. */
    policyField: null,
    boardPolicyKey: "GST_TAX_POLICY",
    why: "Whether input GST is reclaimed decides whether it is part of product cost at all.",
  },
  {
    key: "DEVELOPMENT_CHARGE_POLICY", policyName: "Development and tooling charges",
    families: ["development"],
    /* Null deliberately, like the three above: the retired
       `CostingPolicy.developmentCharges` must not make this read as answered.
       A company still holding the old table has a list of amounts nobody
       approved, which is exactly what this migration stopped applying. */
    policyField: null,
    boardPolicyKey: "DEVELOPMENT_CHARGE_POLICY",
    why: "Setup the company performs itself has no supplier and no quotation. It is priced from "
      + "a published company charge or it is not priced.",
  },
  {
    key: "DUTY_POLICY", policyName: "Customs duty",
    families: ["duty"],
    /* ── IT HAS A RECORD NOW ──────────────────────────────────────────
       This said "there is no duty table in this system", which was true and is
       no longer: the Board approves one, keyed by tariff heading and ISO-2
       origin, effective-dated like every other policy here.

       Null `policyField`, like the rest: nothing on the retired costing policy
       may make this read as answered. */
    policyField: null,
    boardPolicyKey: "DUTY_POLICY",
    why: "Imported goods attract duty by heading and origin. Store records what is imported and from "
      + "where, the item master carries the customs classification, and this table says what that "
      + "combination costs. A missing rule is never a rate of nil.",
  },
  {
    key: "CONTINGENCY_POLICY", policyName: "Standard contingency",
    /* ── BLOCKS NO COST FAMILY, AND THAT IS NOT AN OVERSIGHT ────────────
       A contingency is a cushion ON a cost, not an input TO one. Every
       material, operation and quotation can be complete and the costing fully
       calculable while this question is open — what is unstated is the
       company's risk posture, not any figure. The engine's own model agrees:
       the line is `MISC`, which `costCoverage` lists as ungated, so no family
       waits on it.

       So it is reported as an open BOARD decision rather than a blocked cost
       family. Making it blocking would refuse costings a company can
       legitimately raise; omitting it entirely is what let "nobody decided"
       read as "none", which is the defect this migration closes. */
    families: [],
    /* Null deliberately, like the five above: the retired
       `CostingPolicy.contingencyRatePercent` must not make this read as
       answered. A company still holding the old rate has a number nobody
       approved. */
    policyField: null,
    boardPolicyKey: "CONTINGENCY_POLICY",
    why: "Whether the company adds a standard cushion to what it quotes, and on what subtotal. "
      + "A costing with the question open is calculable and incomplete: it carries no contingency, "
      + "which is not the same as the company having decided not to carry one.",
  },
  {
    key: "MARGIN_GUARDRAILS", policyName: "Pricing floor — management markup",
    /* Blocks no COST family — it governs the selling decision, which is a
       different readiness question and is not this panel's business. What it
       DOES block is the price, and the version-creation guard says so by
       name rather than letting the engine complain about a field. */
    families: [],
    /* Null deliberately, like the six above: the retired
       `CostingPolicy.minimumMarginPercent` must not make this read as
       answered — and here it would read as answered on EVERY company, since
       the old schema defaulted all three to "0". */
    policyField: null,
    boardPolicyKey: "MARGIN_POLICY",
    why: "The floor a price is measured against, the return the company aims for, and where it "
      + "would rather open. It changes no cost — and without it there is no selling price at all.",
  },
]);

const REQUIREMENT_KEYS = Object.freeze(REQUIREMENTS.map((r) => r.key));
const SOURCE_APP_KEYS = Object.freeze(Object.values(SOURCE_APP));

/** Lane A's family, named once so the exclusion is a fact and not an omission. */
const EXCLUDED_FAMILIES = Object.freeze(["packaging"]);

/** Every requirement one app owns, for one kind of subject. */
function requirementsFor(sourceApp, subject = null) {
  return REQUIREMENTS.filter((r) => r.sourceApp === sourceApp
    && (subject ? r.subject === subject : true));
}

/** Which apps a set of department grants lets somebody read. */
function appsForGrants(grants = {}, { isAdmin = false } = {}) {
  const rank = { viewer: 1, editor: 2, approver: 3, owner: 4 };
  return SOURCE_APP_KEYS.filter((app) => {
    const need = APP_GRANT[app];
    if (!need) return false;
    /* ── AN ADMINISTRATOR IS NOT EVERY DEPARTMENT ────────────────────
       They may READ any app's list, which is what a platform administrator
       diagnosing a stuck costing needs. It grants nothing about rates or
       policy values — those are never in this payload for anybody. */
    if (isAdmin) return true;
    const have = rank[String(grants[need.departmentSlug] || "").toLowerCase()] || 0;
    return have >= (rank[need.minimumRole] || 0);
  });
}

module.exports = {
  SOURCE_APP, SOURCE_APP_KEYS, APP_GRANT, SUBJECT,
  STATUS, STATUS_LABEL, BLOCKING_STATUSES,
  SOURCE_FORM, BLOCKER, SCOPE,
  REQUIREMENTS, REQUIREMENT_KEYS, BOARD_POLICIES, EXCLUDED_FAMILIES,
  requirementsFor, appsForGrants,
};
