// services/ppc/planningReadiness.contract.js
//
// TWO QUESTIONS THAT SOUND LIKE ONE, KEPT APART ON PURPOSE.
//
//   1. Is this confirmed order line ELIGIBLE FOR THE ORDER BOOK?
//   2. Is it READY FOR A PLANNING FILE TO BE CREATED?
//
// ── WHY CONFLATING THEM IS THE FAILURE THIS FILE PREVENTS ───────────────────
// The tempting design shows only the lines whose inputs are complete. It
// produces a register that is always tidy and always wrong: an order with no
// engineering release simply is not there, so "nothing is waiting on IE" and
// "IE has not released anything" render identically — as an empty, calm screen.
// The lines that need chasing are exactly the ones such a register hides.
//
// So eligibility is deliberately almost nothing: a stable company and
// order-line identity. Every confirmed line appears, including the ones with
// nothing attached, and their missing inputs are stated as missing.
//
// Readiness is the stricter question, and it is asked ONLY when somebody tries
// to create a planning file. It has four requirements and they are all
// documents somebody signed:
//
//   · a confirmed order-line identity;
//   · the current Merchandising Execution Pack submitted AND accepted by PPC;
//   · the current IE release accepted by PPC;
//   · current issued PPM minutes.
//
// ── STORE AND SUPPLY ARE CONTEXT, NOT A GATE ────────────────────────────────
// Material status is shown on every row and in every detail, and it decides
// nothing. It is another department's statement about itself, travelling
// through Merchandising's projection, and PPC neither owns it nor was given
// authority over it. Making it a requirement would invent a gate no department
// agreed to, and — worse — would make PPC's screen the place where Store's
// silence becomes a refusal. A planner who wants to wait for material puts the
// line ON_HOLD with `AWAITING_MATERIAL`, which is a decision with a name on it.
//
// ── AND "READY TO PLAN" IS NOT "PRODUCTION READY" ───────────────────────────
// Nothing in this file, and no value it produces, means an order may be made.
// It means PPC has the authoritative inputs it needs to start writing down a
// plan. Capacity, line allocation and the release to Production are later
// chunks and are not represented here at all.
"use strict";

/* ══ HOW A SOURCE READ CAN GO ═════════════════════════════════════════════ */

/**
 * The four honest answers about one upstream input — and `UNREADABLE` is the
 * one that matters most.
 *
 * A source read can FAIL. When it does, the only honest thing a screen can say
 * is "couldn't check". Saying `MISSING` claims the source was consulted and had
 * nothing; saying zero claims it was measured; showing a tick claims it was
 * approved. All three turn a broken read into a fact, and a planner acts on it.
 *
 * This is the same reasoning as Merchandising's own availability vocabulary in
 * `services/merchandising/departmentStatus.contract.js`, kept deliberately
 * parallel so the two registers do not develop two dialects for one idea.
 */
const INPUT_STATE = Object.freeze({
  /* Present, current, and in the state PPC needs. */
  SATISFIED: "SATISFIED",
  /* Present, but not yet in the state PPC needs — submitted, not accepted. */
  PENDING: "PENDING",
  /* Consulted, and there is genuinely nothing. */
  MISSING: "MISSING",
  /* Present, but it has moved since the plan was made. */
  MOVED: "MOVED",
  /* The read failed. Not missing. Not zero. Not ready. */
  UNREADABLE: "UNREADABLE",
});
const INPUT_STATES = Object.freeze(Object.values(INPUT_STATE));

/** What a screen prints for each, so one vocabulary reaches every surface. */
const INPUT_WORDS = Object.freeze({
  SATISFIED: "Ready",
  PENDING: "Awaiting acceptance",
  MISSING: "Not received",
  MOVED: "Source moved",
  UNREADABLE: "Couldn’t check",
});

/** Only `SATISFIED` counts towards readiness. Everything else does not. */
const isSatisfied = (state) => state === INPUT_STATE.SATISFIED;

/**
 * Whether an input state is a definite negative.
 *
 * `UNREADABLE` is NOT: a failed read is not evidence of absence, so a row
 * carrying one is neither ready nor provably blocked, and it must not be
 * counted into a "blocked" total a planner would then work through.
 */
const isDefiniteNegative = (state) => state === INPUT_STATE.MISSING
  || state === INPUT_STATE.MOVED;

/* ══ THE FOUR REQUIREMENTS ════════════════════════════════════════════════ */

/**
 * The inputs a planning file requires, in the order a planner chases them.
 *
 * `material` is deliberately absent. It appears in `CONTEXT_INPUTS` below.
 */
const REQUIRED_INPUTS = Object.freeze([
  {
    key: "orderLine",
    label: "Confirmed order line",
    owner: "Sales / Merchandising",
    requirement: "A confirmed order line with a stable company and line identity.",
  },
  {
    key: "executionPack",
    label: "Merchandising Execution Pack",
    owner: "Merchandising",
    requirement: "The current pack submitted, and accepted by PPC.",
  },
  {
    key: "ieRelease",
    label: "Engineering release",
    owner: "Industrial Engineering",
    requirement: "The current issued release, accepted by PPC.",
  },
  {
    key: "ppmMinutes",
    label: "Pre-Production Meeting minutes",
    owner: "Merchandising",
    requirement: "Current minutes issued.",
  },
]);

const REQUIRED_KEYS = Object.freeze(REQUIRED_INPUTS.map((i) => i.key));

/**
 * Shown, never required.
 *
 * Kept in its own list so that "is this a gate" is answered by which array a
 * key is in, rather than by a reader remembering an exception.
 */
const CONTEXT_INPUTS = Object.freeze([
  {
    key: "material",
    label: "Material & supply status",
    owner: "Store / Supply Chain",
    requirement: "Context only. Never a PPC gate.",
  },
]);

const CONTEXT_KEYS = Object.freeze(CONTEXT_INPUTS.map((i) => i.key));

/* ══ ELIGIBILITY ══════════════════════════════════════════════════════════ */

/**
 * Almost nothing, on purpose — see the header.
 *
 * A published order line already carries a company and a permanent line
 * reference by construction, so in practice every published line is eligible.
 * The check exists so that a line which somehow lacks an identity is excluded
 * for a NAMED reason rather than crashing a register, and so the rule has one
 * home rather than being implied by whatever the query happened to filter.
 */
function eligibility(line) {
  const missing = [];
  if (!line?.companyId) missing.push("companyId");
  if (!String(line?.orderLineRef || "").trim()) missing.push("orderLineRef");
  if (!String(line?.orderRef || "").trim()) missing.push("orderRef");
  return {
    eligible: missing.length === 0,
    missingIdentity: missing,
  };
}

/* ══ READINESS ════════════════════════════════════════════════════════════ */

/**
 * Whether a planning file may be created, from the input states already
 * computed elsewhere.
 *
 * Takes a map of `{ [key]: INPUT_STATE }` rather than the raw sources, so this
 * rule is a pure function of the four verdicts and can be tested without a
 * database. It returns WHY it is not ready, because "not ready" on its own is
 * the answer a planner cannot act on.
 *
 * A failed read never produces `ready: true`, and never produces `blocked:
 * true` either — `undetermined` is its own answer.
 */
function readiness(inputStates = {}) {
  const unsatisfied = REQUIRED_KEYS.filter((k) => !isSatisfied(inputStates[k]));
  const unreadable = REQUIRED_KEYS.filter((k) => inputStates[k] === INPUT_STATE.UNREADABLE);
  const blocking = REQUIRED_KEYS.filter((k) => isDefiniteNegative(inputStates[k])
    || inputStates[k] === INPUT_STATE.PENDING);

  return {
    ready: unsatisfied.length === 0,
    /* True only when we PROVED something is absent or moved. */
    blocked: unreadable.length === 0 && blocking.length > 0,
    /* True when at least one required input could not be read at all. */
    undetermined: unreadable.length > 0,
    unsatisfied,
    unreadable,
    /* Context keys are reported so a caller can show them, and are never
       consulted above. */
    contextKeys: [...CONTEXT_KEYS],
  };
}

/**
 * The register's own view name for a row.
 *
 * Derived from the planning file's state where one exists, and from readiness
 * where one does not — so a row is in exactly one view and every view total
 * opens the rows behind it.
 */
const VIEW = Object.freeze({
  AWAITING_INPUTS: "awaiting-inputs",
  READY_TO_PLAN: "ready-to-plan",
  PLANNING: "planning",
  PLANNED: "planned",
  BLOCKED: "blocked",
  ALL: "all",
});
const VIEWS = Object.freeze(Object.values(VIEW));

/**
 * Which view one row belongs to.
 *
 * Order matters and is the point: a file that EXISTS is described by its own
 * state, because PPC's own decision outranks a recomputed guess about its
 * inputs. Only a line with no planning file is described by its readiness.
 */
function viewOf({ planningState = null, ready = false, undetermined = false } = {}) {
  if (planningState === "ON_HOLD") return VIEW.BLOCKED;
  if (planningState === "PLANNED") return VIEW.PLANNED;
  if (planningState === "PLANNING" || planningState === "OPEN") return VIEW.PLANNING;
  /* CANCELLED and SUPERSEDED files do not own their line any more, so the line
     is described by its inputs again — it is available to be planned afresh. */
  if (ready && !undetermined) return VIEW.READY_TO_PLAN;
  return VIEW.AWAITING_INPUTS;
}

module.exports = {
  INPUT_STATE, INPUT_STATES, INPUT_WORDS,
  isSatisfied, isDefiniteNegative,
  REQUIRED_INPUTS, REQUIRED_KEYS, CONTEXT_INPUTS, CONTEXT_KEYS,
  eligibility, readiness,
  VIEW, VIEWS, viewOf,
};
