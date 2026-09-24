// services/centralCosting/inputReadiness.js
//
// LANE B — WHERE THE NON-PACKAGING COST FAMILIES ACTUALLY GET ANSWERED.
//
// ── THE DEAD END THIS CLOSES ────────────────────────────────────────────────
// `costCoverage.js` already says WHETHER a family was answered, and says it
// well. What it cannot say is what to DO about a family that was not: it
// carries an owner's department as prose ("Finance"), a one-line prompt, and
// an `authority` a screen has to interpret. The Costing workspace turned that
// into three chips — "Add cost", "Fix at the source", "Review source" —
// rendered as inert `<span>` elements. A reader was told whose problem it was
// and left to find the screen.
//
// So this module is the missing half: for each non-packaging family, the FACTS
// it needs, the ROLE permitted to record each one, and the DESTINATION where
// that person records it. It answers "what is missing, who owns it, where do
// they go" — and it answers nothing about money.
//
// ── COSTING IS NOT A FORM ───────────────────────────────────────────────────
// Nothing here emits an input, a rate field, a quantity field or an override
// action. A family whose fact is missing gets a named owner and a link to the
// register that owns it; a family whose SOURCE does not exist anywhere gets a
// typed blocker naming the missing contract. Neither gets a blank box. A cost
// typed into a costing is a costing that disagrees with the registers it
// claims to be assembled from, and that is the specific outcome this lane
// exists to prevent.
//
// ── AND IT READS ONLY THE FROZEN VERSION ────────────────────────────────────
// Every input to `familiesFor` comes off `CostingVersion`: the frozen
// `completeness`, `freightProvenance`, `policyProvenance` and `policySnapshot`.
// Nothing reads SampleStyle, a quotation register, the costing policy or an
// enquiry live. A supplier revising a quotation tomorrow, or Finance
// publishing a new overhead rate, therefore cannot change what an already
// frozen version says about itself — the same guarantee `offerProvenance` was
// built to give for rates, extended to the readiness statement about them.
//
// The one live thing on a row is the destination LINK, which is navigation and
// makes no claim about what the version was built from.
//
// ── PACKAGING IS NOT HERE ───────────────────────────────────────────────────
// It is Lane A's family, end to end. This module skips it rather than
// describing it, and `FAMILY_KEYS` below is the whole of what Lane B speaks
// for.
"use strict";

/* ── WHERE A FACT GETS RECORDED ─────────────────────────────────────────────
 *
 * A stable identifier, never a URL. The route belongs to the frontend, which
 * owns its own router; a path in this file would be a second place to change
 * when a screen moves, and the one that nobody would remember.
 *
 * `requires` is how a screen decides whether to OFFER the link. It is not a
 * permission check — the destination screen performs its own, and so does the
 * server behind it. It is here so a costing does not send somebody to a wall.
 *
 *   `departmentSlug` + `minimumRole` — the `DepartmentRole` vocabulary
 *      (models/Access/DepartmentRole.js: viewer < editor < approver < owner),
 *      the same one storePurchase and costing capabilities already resolve.
 *   `capability` — a costing capability the caller already holds in
 *      `visibility.capabilities`.
 */
const DESTINATIONS = Object.freeze({
  RND_TECHNICAL_RECORD: {
    id: "RND_TECHNICAL_RECORD",
    label: "Open the technical record",
    description: "R&D records what the style is made of and how much of it is used.",
    requires: { departmentSlug: "research-development", minimumRole: "editor" },
  },
  /* ── WHERE A TECHNICAL CONFIRMATION IS ACTUALLY MADE ──────────────────
     The engineering file, not the technical record: R&D's screen is where the
     record is AUTHORED, and sending somebody there to confirm it would send
     them to a desk that cannot. */
  IE_ENGINEERING_FILE: {
    id: "IE_ENGINEERING_FILE",
    label: "Open the engineering file",
    description:
      "Industrial Engineering confirms the technical revision it reviewed, and approves the "
      + "operation route and SAM built from it.",
    requires: { departmentSlug: "ie", minimumRole: "approver" },
  },
  /* Merchandising's own selection record — the execution file's approved
     revision after an order, the BOM approval before one. */
  MERCHANDISING_SELECTION: {
    id: "MERCHANDISING_SELECTION",
    label: "Open the material selection",
    description: "Merchandising decides which fabric, trim or packaging item this style is made with.",
    requires: { departmentSlug: "merchandiser", minimumRole: "approver" },
  },
  STORE_MATERIAL_QUOTATIONS: {
    id: "STORE_MATERIAL_QUOTATIONS",
    label: "Open the supplier quotation register",
    description: "Store records what a supplier quoted for an item, dated and referenced.",
    requires: { departmentSlug: "store", minimumRole: "editor" },
  },
  STORE_SERVICE_QUOTATIONS: {
    id: "STORE_SERVICE_QUOTATIONS",
    label: "Open the service quotation register",
    description: "Store records what a supplier quoted for a process, dated and referenced.",
    requires: { departmentSlug: "store", minimumRole: "editor" },
  },
  STORE_FREIGHT_QUOTATIONS: {
    id: "STORE_FREIGHT_QUOTATIONS",
    label: "Open the freight quotation register",
    description: "Store records what a transporter quoted for a lane, dated and referenced.",
    requires: { departmentSlug: "store", minimumRole: "editor" },
  },
  SALES_ENQUIRY_DELIVERY_TERMS: {
    id: "SALES_ENQUIRY_DELIVERY_TERMS",
    label: "Open the enquiry delivery terms",
    description: "Sales records who bears the delivery on this order, and where it goes.",
    requires: { departmentSlug: "sales", minimumRole: "editor" },
  },
  OPERATION_MASTER: {
    id: "OPERATION_MASTER",
    label: "Open the operation master",
    description: "The salary basis an operation is costed against.",
    requires: { departmentSlug: "store", minimumRole: "editor" },
  },
  COSTING_POLICY: {
    id: "COSTING_POLICY",
    label: "Open the company costing policy",
    description: "Finance publishes the company's rates and charges here.",
    requires: { capability: "costing.policy.manage" },
  },
  /* ── SALES' STRUCTURED PAYMENT TERMS ──────────────────────────────────
     The advance, how long the balance runs and what it runs from, confirmed
     on the enquiry. Separate from the delivery terms above: they are agreed
     by the same people on the same record and answer different questions,
     and one panel called "terms" would leave a reader unable to tell which
     half was outstanding. */
  SALES_PAYMENT_TERMS: {
    id: "SALES_PAYMENT_TERMS",
    label: "Open the enquiry payment terms",
    description: "Sales records the advance, the credit period and what it is counted from.",
    requires: { departmentSlug: "sales", minimumRole: "editor" },
  },
  /* ── AND THE BOARD'S OWN POLICY SURFACE ───────────────────────────────
     Not the costing policy. What money costs and how a duration becomes a
     figure is an approved, effective-dated Board decision, and pointing at
     the costing screen would send somebody to a field that now refuses the
     write. */
  BOARD_FINANCING_POLICY: {
    id: "BOARD_FINANCING_POLICY",
    label: "Open the Board financing policy",
    description: "The Board approves the financing rate, what period it covers, and how it applies.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_OVERHEAD_POLICY: {
    id: "BOARD_OVERHEAD_POLICY",
    label: "Open the Board overhead policy",
    description: "The Board approves the overhead rate and the costing subtotal it applies to.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_GST_POLICY: {
    id: "BOARD_GST_POLICY",
    label: "Open the Board input GST policy",
    description: "The Board decides whether eligible input GST is reclaimed or is part of product cost.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_DEVELOPMENT_POLICY: {
    id: "BOARD_DEVELOPMENT_POLICY",
    label: "Open the Board development charge catalogue",
    description: "The Board approves what the company charges for development and tooling work it "
      + "does itself, and from when.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_DUTY_POLICY: {
    id: "BOARD_DUTY_POLICY",
    label: "Open the Board customs duty table",
    description: "The Board approves what each customs tariff heading attracts from each country of "
      + "origin, and from when.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_MARGIN_POLICY: {
    id: "BOARD_MARGIN_POLICY",
    label: "Open the Board margin policy",
    description: "The Board approves the commercial floor, the target return and the preferred "
      + "opening position every selling price is solved from.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_CONTINGENCY_POLICY: {
    id: "BOARD_CONTINGENCY_POLICY",
    label: "Open the Board contingency policy",
    description: "The Board decides whether the company adds a standard contingency to what it "
      + "quotes, and on what subtotal — including deciding that it does not.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
  BOARD_LABOUR_POLICY: {
    id: "BOARD_LABOUR_POLICY",
    label: "Open the Board labour methodology",
    description: "The Board approves how a paid month becomes productive time, the employer burden, "
      + "and where machine cost is accounted for.",
    requires: { departmentSlug: "board", minimumRole: "approver" },
  },
});

/* ── A FACT WITH NO SOURCE ANYWHERE ─────────────────────────────────────────
 * Recorded as such rather than given a destination it does not have. A link to
 * a screen that cannot answer the question is worse than no link: it makes the
 * gap look like somebody's neglect instead of the company's missing record. */
const CONTRACT = Object.freeze({
  PRESENT: "PRESENT",
  MISSING: "MISSING",
});

const fact = (key, label, owner, destination, contract = CONTRACT.PRESENT, note = null) =>
  Object.freeze({ key, label, owner, destination, contract, note });

const OWNER = Object.freeze({
  RND: { department: "R&D", departmentSlug: "research-development", minimumRole: "editor" },
  STORE: { department: "Store / Purchase", departmentSlug: "store", minimumRole: "editor" },
  SALES: { department: "Sales", departmentSlug: "sales", minimumRole: "editor" },
  FINANCE: { department: "Finance", capability: "costing.policy.manage" },
  /* Company-wide decisions with an approval and an effective date. Board is its
     own department — it read `ceo` for one release, which made "an executive may
     read HR" and "this person sets company policy" the same grant. This must
     agree with `BOARD_DEPT_SLUG` in `services/board/boardAccess.js`, because a
     signpost naming a grant the app does not actually require sends people to
     ask an administrator for the wrong thing. */
  BOARD: { department: "Board", departmentSlug: "board", minimumRole: "approver" },
  /* ── THE TWO DESKS BETWEEN R&D AND A PRICE ───────────────────────────────
     Merchandising decides WHICH item; Industrial Engineering confirms the
     R&D-derived manufacturing facts by approving the exact revision it
     reviewed. Neither existed here while costing read R&D directly, and their
     absence is why every technical gap was addressed to R&D — including the
     ones R&D had already answered and could do nothing about. */
  MERCHANDISING: { department: "Merchandising", departmentSlug: "merchandiser", minimumRole: "approver" },
  IE: { department: "Industrial Engineering", departmentSlug: "ie", minimumRole: "approver" },
  /* Named so the row can say the truth: nobody in this repository owns it
     yet, and the fix is a decision about records rather than a data entry. */
  UNASSIGNED: { department: "Not yet assigned", unassigned: true },
});

/* ══ THE AUTHORITY STATES, AND THE DESK THAT CLEARS EACH ═══════════════════
 *
 * Stable strings. They are stored in frozen provenance, shown on a Sales
 * screen, and routed to a department — renaming one is a migration.
 *
 * ── WHY THEY ARE NOT ONE "MISSING COSTING DATA" ─────────────────────────────
 * Because they are not one problem and they are not one desk's. "Awaiting IE
 * technical confirmation" and "Merchandising has not approved the selection"
 * send different people to different screens, and a reader told only that
 * something is missing has to go and find out which — which is what a
 * readiness projection exists to spare them.
 *
 * ── AND WHY R&D APPEARS ONLY ONCE ───────────────────────────────────────────
 * R&D owns exactly one of these: the state before a revision has entered the
 * IE chain at all. Once it has, the answer belongs to IE, and naming R&D would
 * send somebody to a desk with nothing left to do.
 */
const AUTHORITY_STATE = Object.freeze({
  AWAITING_RND_TECHNICAL_SUBMISSION: {
    id: "AWAITING_RND_TECHNICAL_SUBMISSION",
    label: "Technical details not submitted",
    owner: OWNER.RND,
    destination: "RND_TECHNICAL_RECORD",
  },
  AWAITING_IE_TECHNICAL_CONFIRMATION: {
    id: "AWAITING_IE_TECHNICAL_CONFIRMATION",
    label: "Awaiting IE technical confirmation",
    owner: OWNER.IE,
    destination: "IE_ENGINEERING_FILE",
  },
  IE_TECHNICAL_APPROVAL_STALE: {
    id: "IE_TECHNICAL_APPROVAL_STALE",
    label: "IE technical approval is stale",
    owner: OWNER.IE,
    destination: "IE_ENGINEERING_FILE",
  },
  TECHNICAL_SOURCE_MISMATCH: {
    id: "TECHNICAL_SOURCE_MISMATCH",
    label: "Technical source does not match the selected style",
    owner: OWNER.IE,
    destination: "IE_ENGINEERING_FILE",
  },
  AWAITING_MERCHANDISING_SELECTION: {
    id: "AWAITING_MERCHANDISING_SELECTION",
    label: "Material not selected",
    owner: OWNER.MERCHANDISING,
    destination: "MERCHANDISING_SELECTION",
  },
  SELECTION_MISMATCH: {
    id: "SELECTION_MISMATCH",
    label: "Store decision does not match the approved material selection",
    owner: OWNER.MERCHANDISING,
    destination: "MERCHANDISING_SELECTION",
  },
  AWAITING_STORE_SOURCING: {
    id: "AWAITING_STORE_SOURCING",
    label: "Supplier quotation not selected or available",
    owner: OWNER.STORE,
    destination: "STORE_MATERIAL_QUOTATIONS",
  },
  STORE_DECISION_MISMATCH: {
    id: "STORE_DECISION_MISMATCH",
    label: "Store decision does not match the approved material selection",
    owner: OWNER.STORE,
    destination: "STORE_MATERIAL_QUOTATIONS",
  },
});

/** The state a binding refusal maps to, by its own name. One vocabulary. */
function authorityStateFor(bindingState) {
  return AUTHORITY_STATE[String(bindingState || "")] || null;
}

/* ── THE EIGHT NON-PACKAGING FAMILIES ───────────────────────────────────────
 * Keys are `costCoverage.FAMILIES` keys, deliberately — one vocabulary, so a
 * decision made against a family here is the same decision the frozen
 * assessment recorded. */
const FAMILIES = Object.freeze([
  {
    key: "materials",
    prompt: "Fabric and trims: how much the style uses, and what a supplier quoted for it.",
    facts: [
      fact("MATERIAL_CONSUMPTION", "How much of each material the style uses", OWNER.RND, "RND_TECHNICAL_RECORD"),
      fact("MATERIAL_QUOTATION", "A dated supplier quotation for each material", OWNER.STORE, "STORE_MATERIAL_QUOTATIONS"),
    ],
    primaryDestination: "STORE_MATERIAL_QUOTATIONS",
  },
  {
    key: "operations",
    prompt: "The production route, and the salary basis each operation is costed against.",
    facts: [
      fact("OPERATION_ROUTE", "The operations this style goes through, and their SAM", OWNER.RND, "RND_TECHNICAL_RECORD"),
      fact("OPERATION_SALARY_BASIS", "The department and designation each operation is paid at", OWNER.STORE, "OPERATION_MASTER"),
      /* ── THE BOARD'S HALF, BESIDE PRODUCTION'S TWO ────────────────────
         Three facts, three owners, deliberately not collapsed: a missing SAM
         is R&D's row to finish, a missing salary basis is the operation
         master's, and the methodology is the Board's. "Labour unavailable"
         would send all three to whichever desk somebody guessed. */
      fact(
        "LABOUR_METHODOLOGY",
        "The Board's labour methodology — productive time, employer burden and machine burden",
        OWNER.BOARD,
        "BOARD_LABOUR_POLICY",
      ),
    ],
    primaryDestination: "OPERATION_MASTER",
  },
  {
    key: "services",
    prompt: "Job work sent outside: which process is required, and what a supplier quoted for it.",
    facts: [
      fact("SERVICE_REQUIREMENT", "The SERVICE processes this style requires", OWNER.RND, "RND_TECHNICAL_RECORD"),
      fact("SERVICE_QUOTATION", "A dated service quotation for each process", OWNER.STORE, "STORE_SERVICE_QUOTATIONS"),
    ],
    primaryDestination: "STORE_SERVICE_QUOTATIONS",
  },
  {
    key: "freight",
    prompt: "Delivering the finished order to the customer.",
    /* ── THE ORDER OF THESE MATTERS ────────────────────────────────────
       Who bears the delivery is answered FIRST, because it decides whether
       there is a company cost at all. A quotation looked up before that
       question is answered prices freight the customer was always going to
       pay. */
    facts: [
      fact("FREIGHT_ARRANGEMENT", "Who bears the delivery on this order — a commercial decision", OWNER.SALES, "SALES_ENQUIRY_DELIVERY_TERMS"),
      fact("FREIGHT_DESTINATION", "The shipping address this order goes to", OWNER.SALES, "SALES_ENQUIRY_DELIVERY_TERMS"),
      fact("SHIPMENT_FACTS", "Packed weight and garments per carton", OWNER.RND, "RND_TECHNICAL_RECORD"),
      fact("FREIGHT_QUOTATION", "A dated transporter quotation for this lane", OWNER.STORE, "STORE_FREIGHT_QUOTATIONS"),
    ],
    primaryDestination: "SALES_ENQUIRY_DELIVERY_TERMS",
  },
  {
    key: "duty",
    prompt: "Duty, and any indirect tax the company cannot reclaim.",
    facts: [
      fact("NON_RECOVERABLE_GST", "The GST treatment on each quotation, and the company's input-GST policy", OWNER.STORE, "STORE_MATERIAL_QUOTATIONS"),
      /* ── TWO CHARGES IN ONE FAMILY, AND ONLY ONE HAS AN ANSWER ────────
         `duty` covers customs duty AND input tax the company cannot reclaim,
         because both are tax that stays with it. They are different charges
         on different events: the GST treatment is a Board decision that now
         exists, and the tariff table is a Board decision that does not. A
         reader has to be able to tell which half is missing. */
      fact(
        "INPUT_GST_TREATMENT",
        "Whether this company reclaims eligible input GST or carries it as cost",
        OWNER.BOARD,
        "BOARD_GST_POLICY",
      ),
      /* ── THREE FACTS NOW, AND EACH HAS AN OWNER ──────────────────────
         This was one unowned fact saying nothing in the system recorded a
         heading, an origin or a rate. All three exist: Store records the
         origin on the quotation, the item master carries the heading, and the
         Board approves the table. Reported separately because they are fixed
         at three different desks, and one message naming none of them sent
         everybody nowhere. */
      fact(
        "IMPORT_SOURCING_EVIDENCE",
        "Whether each purchased input is imported, and from which country",
        OWNER.STORE,
        "STORE_MATERIAL_QUOTATIONS",
      ),
      fact(
        "CUSTOMS_CLASSIFICATION",
        "The customs tariff heading on the item master — not the quotation's GST HSN",
        OWNER.STORE,
        "STORE_MATERIAL_QUOTATIONS",
      ),
      fact(
        "CUSTOMS_DUTY_RATE",
        "The Board's approved duty rate for that heading and origin",
        OWNER.BOARD,
        "BOARD_DUTY_POLICY",
      ),
    ],
    primaryDestination: null,
  },
  {
    key: "financing",
    prompt: "The cost of money tied up in this order.",
    facts: [
      /* ── BOTH HALVES NOW EXIST, AND EACH HAS AN OWNER ─────────────────
         For a long time this family had a rate and no duration, so its
         figure was a percentage of a subtotal with a cost of capital's name
         on it. Sales now confirms the duration on the enquiry and the Board
         approves the methodology, and the two are reported separately
         because either can be the one that is missing. */
      fact(
        "FINANCING_METHODOLOGY",
        "The Board's financing rate, and how a payment duration becomes a figure",
        OWNER.BOARD,
        "BOARD_FINANCING_POLICY",
      ),
      fact(
        "PAYMENT_TERM_DURATION",
        "How long this order's money is out — the confirmed payment terms",
        OWNER.SALES,
        "SALES_PAYMENT_TERMS",
      ),
    ],
    primaryDestination: "BOARD_FINANCING_POLICY",
  },
  {
    key: "development",
    prompt: "Pattern, marker, screens, tooling — one-time costs spread over the run.",
    facts: [
      fact("DEVELOPMENT_REQUIREMENT", "The DEVELOPMENT_TOOLING setup this style requires", OWNER.RND, "RND_TECHNICAL_RECORD"),
      fact("DEVELOPMENT_QUOTATION", "A service quotation, where the setup is bought outside", OWNER.STORE, "STORE_SERVICE_QUOTATIONS"),
      /* ── THE IN-HOUSE HALF IS A BOARD DECISION NOW ───────────────────
         A charge for work the company does itself is a price the company
         publishes about its own capability — no supplier quoted it and no
         department measured it — so it is approved, dated and attributed like
         the other Board policies rather than typed into the costing screen.
         The other two facts are unchanged: the requirement is still R&D's and
         the outside quotation is still Store's. */
      fact("DEVELOPMENT_CHARGE", "A published company charge, where the work is done in-house", OWNER.BOARD, "BOARD_DEVELOPMENT_POLICY"),
    ],
    primaryDestination: "BOARD_DEVELOPMENT_POLICY",
  },
  {
    key: "overhead",
    prompt: "Company and factory overhead — what the company adds to cover what it costs to run.",
    facts: [
      /* One fact, one owner: unlike financing there is no operational half.
         Nothing a department records changes this rate. */
      fact(
        "OVERHEAD_METHODOLOGY",
        "The Board's overhead rate, and the costing subtotal it applies to",
        OWNER.BOARD,
        "BOARD_OVERHEAD_POLICY",
      ),
    ],
    primaryDestination: "BOARD_OVERHEAD_POLICY",
  },
]);

const FAMILY_KEYS = Object.freeze(FAMILIES.map((f) => f.key));
const FAMILY_BY_KEY = Object.freeze(
  FAMILIES.reduce((acc, f) => { acc[f.key] = f; return acc; }, {}),
);

/** Lane A's family. Named once, so the exclusion is a fact and not an omission. */
const EXCLUDED_FAMILY_KEYS = Object.freeze(["packaging"]);

/* ── SEVEN STATES, AND FOUR OF THEM ARE ANSWERS ─────────────────────────────
 * `costCoverage.STATE` has five and collapses two distinctions this lane
 * needs: a fact nobody recorded is not the same as a DECISION nobody made,
 * and neither is the same as a family the company has no record for at all.
 * The three read differently, are owned by different desks, and are fixed in
 * three different places. */
const READINESS = Object.freeze({
  READY: "READY",
  RECORDED_NIL: "RECORDED_NIL",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  MISSING_INPUT: "MISSING_INPUT",
  AWAITING_DECISION: "AWAITING_DECISION",
  BLOCKED_SOURCE: "BLOCKED_SOURCE",
  SOURCE_CONTRACT_MISSING: "SOURCE_CONTRACT_MISSING",
});

const READINESS_LABEL = Object.freeze({
  READY: "Ready",
  RECORDED_NIL: "Recorded as nil",
  NOT_APPLICABLE: "Not applicable",
  MISSING_INPUT: "Missing data",
  AWAITING_DECISION: "Needs a commercial decision",
  BLOCKED_SOURCE: "Blocked at the source",
  SOURCE_CONTRACT_MISSING: "No source exists yet",
});

/** The states that stop a costing being complete. Four are answers; three are not. */
const BLOCKING = Object.freeze([
  READINESS.MISSING_INPUT,
  READINESS.AWAITING_DECISION,
  READINESS.BLOCKED_SOURCE,
  READINESS.SOURCE_CONTRACT_MISSING,
]);

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * Freight, and the one distinction that is worth the extra branch.
 *
 * `prepaid` means the company pays the carrier and says NOTHING about whether
 * it recovers that from the customer — two readings that differ by the whole
 * freight amount. The frozen `freightProvenance` records the arrangement and,
 * where the arrangement was `prepaid`, the treatment somebody chose. So a
 * freight family that produced nothing is either:
 *
 *   · a commercial decision nobody has made — no arrangement at all, or a
 *     `prepaid` with no treatment — which Sales owns, or
 *   · data missing behind an arrangement that WAS decided, which is a
 *     quotation or a shipment fact.
 *
 * Derived from what the version froze, never guessed. A version with no
 * freight provenance at all has no arrangement on it, and "nobody has said who
 * bears the delivery" is exactly the truthful reading of that.
 */
function freightSubstate(freightProvenance) {
  const arrangement = freightProvenance?.arrangement || null;
  if (!present(arrangement)) {
    return { state: READINESS.AWAITING_DECISION, factKey: "FREIGHT_ARRANGEMENT" };
  }
  if (arrangement === "prepaid" && !present(freightProvenance?.prepaidTreatment)) {
    return { state: READINESS.AWAITING_DECISION, factKey: "FREIGHT_ARRANGEMENT" };
  }
  return { state: READINESS.MISSING_INPUT, factKey: null };
}

/**
 * The frozen coverage state → the readiness state, for ONE family.
 *
 * `authority` comes off the frozen assessment, so a version calculated before
 * a family had a source still reads the way it read then. That is the point:
 * "no source existed when this was costed" is a true statement about a March
 * version even after the register was built in June.
 */
function stateFor(frozen, { freightProvenance = null } = {}) {
  switch (frozen?.state) {
    case "CALCULATED": return { state: READINESS.READY, factKey: null };
    case "RECORDED_ZERO": return { state: READINESS.RECORDED_NIL, factKey: null };
    case "NOT_APPLICABLE": return { state: READINESS.NOT_APPLICABLE, factKey: null };
    case "SOURCE_UNAVAILABLE": return { state: READINESS.BLOCKED_SOURCE, factKey: null };
    case "NEEDS_INPUT":
      /* No authoritative record exists for this family anywhere. Not a gap in
         the screen — a gap in the company's records, and the difference is
         whether the answer is "enter it" or "somebody has to decide how this
         is recorded at all". */
      if (frozen.authority === "AWAITING_SOURCE") {
        return { state: READINESS.SOURCE_CONTRACT_MISSING, factKey: null };
      }
      if (frozen.key === "freight") return freightSubstate(freightProvenance);
      return { state: READINESS.MISSING_INPUT, factKey: null };
    default:
      /* An unknown state is not an answer. Reporting it as one would be the
         "absent section reads as none needed" defect in a new place. */
      return { state: READINESS.MISSING_INPUT, factKey: null };
  }
}

/** Plain language, per state, naming the family rather than the enum. */
function explain(contract, readiness, frozen, missingFacts) {
  const owners = [...new Set(missingFacts.map((f) => f.owner.department))];
  switch (readiness) {
    case READINESS.READY:
      return `Costed from ${frozen.basis || "the sources this version was assembled from"}.`;
    case READINESS.RECORDED_NIL:
      return `A rule was applied and came to nil. ${frozen.basis || "Recorded as an answer, not left empty."}`;
    case READINESS.NOT_APPLICABLE:
      return "Somebody decided this does not apply to this order. The decision, its author and its date are frozen on this version.";
    case READINESS.AWAITING_DECISION:
      return `This is waiting on a commercial decision, not on data. ${owners.join(" and ") || "Sales"} answers it per order, and it is never priced at nil while unanswered.`;
    case READINESS.BLOCKED_SOURCE:
      return frozen.reason
        || "The source this family comes from was expected to answer and did not. Nobody has failed to act.";
    case READINESS.SOURCE_CONTRACT_MISSING:
      return "There is no authoritative record for this in the system yet, so it cannot be costed — and it is not treated as nil. "
        + "It needs a source, not a figure typed into this costing.";
    case READINESS.MISSING_INPUT:
    default:
      return `${contract.prompt} ${owners.length ? `Recorded by ${owners.join(" and ")}, at its own source.` : ""}`.trim();
  }
}

/**
 * The read-only working, where there is one.
 *
 * Amounts stay in minor units — this module formats nothing, because a second
 * money formatter is a second answer, and the phone would be the one nobody
 * checked. Everything here comes off the frozen version.
 */
function evidenceFor(family, frozen, {
  freightProvenance, policyProvenance, policySnapshot,
  financingProvenance, overheadProvenance, labourProvenance,
}) {
  const entries = [];

  if (present(frozen.perUnitMinor)) entries.push({ key: "perUnit", label: "Per unit", amountMinor: frozen.perUnitMinor });
  if (present(frozen.totalMinor)) entries.push({ key: "total", label: "For the run", amountMinor: frozen.totalMinor });
  if (frozen.basis) entries.push({ key: "basis", label: "Basis", value: frozen.basis });

  if (family.key === "freight" && freightProvenance) {
    const lane = [freightProvenance.origin?.name, freightProvenance.destination?.label]
      .filter(Boolean).join(" → ");
    if (freightProvenance.arrangement) {
      entries.push({
        key: "arrangement", label: "Delivery arrangement",
        value: freightProvenance.arrangement,
        note: freightProvenance.arrangementSource || null,
      });
    }
    if (lane) entries.push({ key: "lane", label: "Lane", value: lane });
    if (freightProvenance.mode) entries.push({ key: "mode", label: "Mode", value: freightProvenance.mode });
    if (freightProvenance.supplierName) {
      entries.push({
        key: "carrier", label: "Transporter",
        value: freightProvenance.supplierName,
        note: freightProvenance.quotationReference || null,
      });
    }
  }

  /* ── OVERHEAD IS EXPLAINED FROM ITS OWN PROVENANCE WHERE THERE IS ONE ─
     A version frozen since the Board took the rate over carries the rule AND
     what it was applied to. An older one has only the snapshot, which is the
     honest thing to show for it — that IS what it was calculated with. */
  /* ── LABOUR IS EXPLAINED FROM ITS OWN FROZEN RULE ─────────────────────
     The method AND what it resolved to: "80% efficiency" is a decision and
     "9,984 minutes" is what the arithmetic actually divided by, and a reader
     checking a rate needs both. */
  const lb = labourProvenance;
  if (family.key === "operations" && lb && lb.state === "APPLIED") {
    entries.push({
      key: "productive",
      label: "Productive minutes",
      value: lb.productiveBasis === "EFFICIENCY"
        ? `${lb.labourEfficiencyPercent}% of paid time — ${lb.productiveMinutesResolved || "?"} a month`
        : `${lb.productiveMinutesPerMonth} a month, stated`,
    });
    if (present(lb.employerBurdenPercent)) {
      entries.push({ key: "burden", label: "Employer burden", value: `${lb.employerBurdenPercent}%` });
    }
    if (lb.machineBurdenTreatment) {
      entries.push({
        key: "machine",
        label: "Machine cost",
        value: String(lb.machineBurdenTreatment).toLowerCase().replace(/_/g, " "),
      });
    }
  }

  const oh = overheadProvenance;
  if (family.key === "overhead" && oh) {
    if (present(oh.ratePercent)) {
      entries.push({ key: "rate", label: "Overhead rate", value: `${oh.ratePercent}%` });
    }
    if (oh.basis) {
      entries.push({ key: "basis", label: "Applied to", value: String(oh.basis).toLowerCase().replace(/_/g, " ") });
    }
  } else if (family.key === "overhead" && present(policySnapshot?.overheadRatePercent)) {
    entries.push({ key: "rate", label: "Overhead rate", value: `${policySnapshot.overheadRatePercent}%` });
  }
  /* ── FINANCING IS EXPLAINED FROM ITS OWN PROVENANCE ───────────────────
     Not from the policy snapshot, which carries the retired flat rate and
     would show a figure this version was not calculated with. What is on the
     record is the Board's rule AND this order's terms, and both are needed
     for the number to be checkable a year later. */
  const fin = financingProvenance;
  if (family.key === "financing" && fin) {
    if (present(fin.annualRatePercent)) {
      entries.push({ key: "rate", label: "Financing rate", value: `${fin.annualRatePercent}% a year` });
    }
    if (fin.creditDays !== null && fin.creditDays !== undefined) {
      entries.push({
        key: "duration",
        label: "Money outstanding",
        value: fin.creditDays === 0
          ? "Due immediately"
          : `${fin.creditDays} days${fin.creditDaysFrom ? ` from ${String(fin.creditDaysFrom).toLowerCase().replace(/_/g, " ")}` : ""}`,
      });
    }
    if (present(fin.financedSharePercent)) {
      entries.push({ key: "share", label: "Share financed", value: `${fin.financedSharePercent}%` });
    }
    if (fin.state === "NOT_APPLICABLE" && fin.notApplicableReason) {
      entries.push({ key: "not-applicable", label: "Does not apply", value: fin.notApplicableReason });
    }
  }
  if (family.key === "development") {
    /* Each published charge that produced part of this family's total, named
       and dated, so the run figure can be re-derived rather than trusted. */
    for (const p of policyProvenance || []) {
      if (!p?.chargeLabel) continue;
      entries.push({
        key: `charge:${p.chargeKey || p.lineKey}`,
        label: "Company charge",
        value: p.chargeLabel,
        amountMinor: present(p.amountMinor) ? p.amountMinor : null,
        note: p.effectiveFrom ? `In force from ${p.effectiveFrom}` : null,
      });
    }
  }

  return entries.length ? { entries } : null;
}

/**
 * One family's readiness row.
 *
 * @param {object} frozen  one entry of the frozen `completeness.families[]`,
 *   as `visibility.js` publishes it: `{key, label, state, authority, owner,
 *   basis, reason, totalMinor, perUnitMinor, decidedByName, decidedAt}`.
 */
function rowFor(frozen, sources = {}) {
  const contract = FAMILY_BY_KEY[frozen.key];
  if (!contract) return null;

  const { state, factKey } = stateFor(frozen, sources);
  const blocking = BLOCKING.includes(state);

  /* ── WHAT IS MISSING ──────────────────────────────────────────────────
     The version froze a family's STATE and its owning department; it did not
     freeze WHICH of the family's facts was the one that was absent (see
     docs/tasks/central-costing-lane-b-input-map.md §5.3 — closing that is a
     change to CostingVersion, which is Lane A's).

     So a blocked family reports the facts it NEEDS, which is a true statement
     and a useful one, rather than a claim about which single fact failed that
     the record cannot support. Where the frozen provenance DOES narrow it —
     freight's arrangement — the narrowing fact is marked. */
  const missingFacts = blocking
    ? contract.facts
      .filter((f) => (factKey ? f.key === factKey : true))
      .map((f) => ({
        key: f.key,
        label: f.label,
        owner: { ...f.owner },
        destination: f.destination,
        sourceContract: f.contract,
        note: f.note,
      }))
    : [];

  const contractState = contract.facts.every((f) => f.contract === CONTRACT.MISSING)
    ? CONTRACT.MISSING
    : (contract.facts.some((f) => f.contract === CONTRACT.MISSING) ? "PARTIAL" : CONTRACT.PRESENT);

  /* Where the reader goes. The fact that narrows the gap wins; otherwise the
     family's own primary desk. A family with no source has nowhere to send
     anybody, and says so instead of pointing at a screen that cannot help. */
  const destinationId = state === READINESS.SOURCE_CONTRACT_MISSING
    ? null
    : (missingFacts.find((f) => f.destination)?.destination
      || (blocking ? contract.primaryDestination : null));
  const destination = destinationId ? { ...DESTINATIONS[destinationId] } : null;

  return {
    key: frozen.key,
    label: frozen.label || frozen.key,
    /* The frozen coverage state, carried through unchanged so a reader can
       always get back to what the assessment itself said. */
    coverageState: frozen.state || null,
    state,
    stateLabel: READINESS_LABEL[state],
    blocking,
    prompt: contract.prompt,
    explanation: explain(contract, state, frozen, missingFacts),
    owner: frozen.owner
      ? { department: frozen.owner.department || null, system: frozen.owner.system || null }
      : null,
    missingFacts,
    destination,
    /* The audit trail of an intentional exclusion. Present only where somebody
       actually made the decision — never a default message. */
    decision: state === READINESS.NOT_APPLICABLE
      ? {
        reason: frozen.reason || null,
        decidedByName: frozen.decidedByName || null,
        decidedAt: frozen.decidedAt || null,
        /* A decision missing its author or its date is not an audited
           decision, and a screen that showed it as one would be laundering
           it. Said here rather than inferred there. */
        audited: Boolean(frozen.decidedByName && frozen.decidedAt && frozen.reason),
      }
      : null,
    evidence: (state === READINESS.READY || state === READINESS.RECORDED_NIL)
      ? evidenceFor(contract, frozen, sources)
      : null,
    sourceContract: contractState,
    /* Every fact of this family that the company has no record for. Named on
       the row so a blocker can be read without opening the design document. */
    missingSourceContracts: contract.facts
      .filter((f) => f.contract === CONTRACT.MISSING)
      .map((f) => ({ key: f.key, label: f.label, owner: { ...f.owner }, note: f.note })),
  };
}

/**
 * The whole non-packaging readiness payload for one frozen version.
 *
 * @param {object} completeness  the frozen assessment, in the shape
 *   `visibility.js` publishes: `{recorded, costComplete, families[]}`.
 * @param {object} version  the frozen version's cost block, for its provenance
 *   arrays. Only frozen fields are read; nothing here resolves a live source.
 * @param {object} policySnapshot  the policy AS IT STOOD when the version
 *   froze — not the policy as it stands now. Passed separately because the
 *   cost block publishes only its cost-shaping half.
 */
function forVersion({ completeness = null, version = null, policySnapshot = null } = {}) {
  if (!completeness || completeness.recorded === false) {
    /* Unassessed is its own answer. Not ready and not blocked — nobody
       looked, and rendering either would be a claim nobody made. */
    return { recorded: false, families: [], blocking: [] };
  }

  const sources = {
    freightProvenance: version?.freightProvenance || null,
    policyProvenance: version?.policyProvenance || [],
    /* The Board rule AND this order's terms, as they stood. Read instead of
       the snapshot's retired flat rate, which this version was not calculated
       with. */
    financingProvenance: version?.financingProvenance || null,
    /* The Board's overhead rule as it stood, where the version carries one. */
    overheadProvenance: version?.overheadProvenance || null,
    /* The Board's labour methodology as it stood, where the version has one. */
    labourProvenance: version?.labourProvenance || null,
    policySnapshot: policySnapshot || {},
  };

  const families = (completeness.families || [])
    .filter((f) => f && !EXCLUDED_FAMILY_KEYS.includes(f.key))
    .map((f) => rowFor(f, sources))
    .filter(Boolean);

  return {
    recorded: true,
    families,
    blocking: families
      .filter((f) => f.blocking)
      .map((f) => ({ key: f.key, label: f.label, state: f.state })),
  };
}

module.exports = {
  AUTHORITY_STATE, authorityStateFor,
  DESTINATIONS, CONTRACT, OWNER,
  FAMILIES, FAMILY_KEYS, FAMILY_BY_KEY, EXCLUDED_FAMILY_KEYS,
  READINESS, READINESS_LABEL, BLOCKING,
  stateFor, freightSubstate, rowFor, forVersion,
};
