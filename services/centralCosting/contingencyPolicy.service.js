// services/centralCosting/contingencyPolicy.service.js
//
// WHETHER THE COMPANY ADDS A STANDARD CONTINGENCY TO WHAT IT QUOTES.
//
// ── THREE ANSWERS, NOT TWO ──────────────────────────────────────────────────
// Every other Board policy in this lane resolves to "in force" or "not
// decided". This one has a third, and the whole migration turns on it:
//
//   APPLIED       the Board approved a rate on a stated basis, and the engine
//                 charges it.
//   DECIDED_NONE  the Board considered it and decided the company does not add
//                 a standard contingency. Nothing is charged, and the version
//                 records WHO decided that and WHEN — because "no contingency"
//                 with a name against it is evidence, and "no contingency"
//                 because nobody looked is not.
//   POLICY_MISSING nobody has decided.
//
// Under the retired writer the last two were the same record: an absent rate
// produced no line and said nothing. A costing could not distinguish a company
// that had deliberately chosen not to carry contingency from one where the
// question had never been asked, and neither could an auditor a year later.
//
// ── AND THE ARITHMETIC IS NOT HERE ──────────────────────────────────────────
// `engine.js` synthesises the line from `policy.contingencyRatePercent` and
// `policy.contingencyBasis`, orders it against every other percentage line and
// rounds it once. None of that changes. This module decides only WHETHER those
// two names are filled, and from which approved version.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");

const POLICY_KEY = "CONTINGENCY_POLICY";

const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company contingency policy" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  DECIDED_NONE: "DECIDED_NONE",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "CONTINGENCY_POLICY_MISSING",
});

/** The decision a stored version carries, read without the database. */
function decisionOf(policy = null) {
  const c = policy?.contingency || {};
  if (!policy || !c.mode) {
    return {
      state: STATE.POLICY_MISSING,
      mode: null,
      ratePercent: null,
      basis: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        /* ── SAID AS AN OPEN QUESTION, NOT AS A NIL ────────────────────
           The costing goes on being calculable — a contingency is a cushion
           on a cost, not an input to it — but the figure it produces is a
           company's cost with an unanswered question in it, and the screen
           has to say so rather than let silence read as "none". */
        message: "The Board has not said whether this company adds a standard contingency. "
          + "This costing carries none — which is not the same as the company having decided not to.",
      }],
    };
  }
  if (c.mode === "NONE") {
    return {
      state: STATE.DECIDED_NONE,
      mode: "NONE",
      ratePercent: null,
      basis: null,
      /* Not a gap. Somebody decided, and the decision is recorded. */
      missing: [],
    };
  }
  return {
    state: STATE.APPLIED,
    mode: "APPLY",
    ratePercent: c.ratePercent ?? null,
    basis: c.basis ?? null,
    missing: [],
  };
}

/**
 * The decision in force for this company on this costing's date.
 *
 * Against the costing's own date, never against now: a costing dated in March
 * reads March's decision, and a policy approved since — even one backdated —
 * is simply not the version this query selects.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return { policy: policy || null, ...decisionOf(policy) };
}

/**
 * The two names `engine.js` reads, filled from the approved decision.
 *
 * ── WHY `DECIDED_NONE` FILLS NOTHING RATHER THAN A ZERO ─────────────────────
 * The engine already distinguishes them, and the distinction is the point:
 *
 *   a rate of "0"   → a real MISC line of zero on a stated basis, in every
 *                     build-up, which a later Board can raise without changing
 *                     the shape of the cost sheet;
 *   no rate at all  → no line.
 *
 * A Board that decided the company does not add a standard contingency has not
 * set it to nil — it has said the company does not work that way. Overlaying a
 * "0" would put a contingency line on every costing of a company that does not
 * have contingency, and the two decisions would stop being tellable apart in
 * exactly the record that has to keep them apart. So `NONE` overlays nothing,
 * and what makes it an AUDITED nothing is the frozen provenance below, not a
 * fabricated line.
 */
function overlayFor(resolved) {
  if (resolved?.state !== STATE.APPLIED) {
    return { contingencyRatePercent: undefined, contingencyBasis: undefined };
  }
  return {
    contingencyRatePercent: resolved.ratePercent ?? undefined,
    contingencyBasis: resolved.basis ?? undefined,
  };
}

/**
 * What gets frozen onto the version.
 *
 * ── INCLUDING WHEN NOTHING WAS CHARGED ──────────────────────────────────────
 * Frozen for `DECIDED_NONE` as well as `APPLIED`, and that is the half the old
 * record could not hold. A version that simply has no contingency line is
 * mute: it cannot say whether the company decided against one, or whether
 * nobody had decided when it was priced. This block says which, with the name
 * and date behind it.
 *
 * `basisAmountMinor` and `contingencyMinor` are per scenario and are read off
 * the engine's own result rather than recomputed — a provenance block that
 * recalculated the figure could disagree with the figure it describes.
 */
function freeze({ resolved, scenarios = [], asOf = new Date() }) {
  const policy = resolved?.policy || null;
  return {
    state: resolved?.state || STATE.POLICY_MISSING,
    mode: resolved?.mode || null,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    /* The reason, carried onto the version. For a `NONE` decision it is the
       substance of the record: it is what an auditor reads instead of a line. */
    rationale: policy?.rationale || "",
    ratePercent: resolved?.ratePercent ?? null,
    basis: resolved?.basis ?? null,
    scenarios,
  };
}

/**
 * The per-scenario working, taken from the calculated result.
 *
 * Empty for every state but `APPLIED`: there is no working behind a decision
 * not to charge something, and inventing rows of zero would be the fabricated
 * cost this policy exists to avoid.
 */
function workingsFrom(calculated, resolved) {
  if (resolved?.state !== STATE.APPLIED) return [];
  const out = [];
  for (const s of calculated?.scenarios || []) {
    const line = (s.lines || []).find((l) => l.lineKey === "policy:contingency");
    if (!line) continue;
    out.push({
      scenarioKey: s.key,
      basisAmountMinor: line.basisAmountMinor ?? null,
      contingencyMinor: line.totalMinor ?? null,
    });
  }
  return out;
}

/**
 * The retired costing-policy rule, in the shape a Board draft takes.
 *
 * ── WHY IT IS OFFERED, AND WHY IT IS ONLY OFFERED ───────────────────────────
 * Companies already carry a rate and a basis here. The migration stops them
 * being CHARGED — nobody approved them — but making the Board retype a figure
 * it is about to ratify invites a transcription error into a rule applied to
 * every costing in the company.
 *
 * What does not travel is any suggestion that it is settled. This returns
 * material for a DRAFT, always as `APPLY` with the old numbers filled in: the
 * legacy record can only ever have meant "we add this much", since the shape
 * had no way to express a decision not to. A Board that actually wants NONE
 * says so itself, with its reason — which is exactly the statement the old
 * field could not hold.
 *
 * ── AND A LEGACY BASIS THE ENGINE CANNOT CHARGE IS LEFT BLANK ──────────────
 * Four of the eleven bases contain the contingency line's own category, so a
 * costing charged on one could never be calculated — and the retired writer
 * accepted all eleven, so those are precisely the companies whose costings
 * have been failing. Carrying such a basis into the seed would refuse the
 * draft outright and leave them with no way to fix it here.
 *
 * So the rate travels and the unusable basis does not, and the draft opens
 * with an explicit gap asking which subtotal to charge on. Substituting a
 * workable basis instead would be this module deciding what the company
 * charges contingency on, which is the Board's to decide and the reason the
 * old value cannot simply be ratified.
 */
async function legacySeed(ctx) {
  /* Required lazily: `policy.service` requires this module, and requiring it
     back at load time would close the cycle before either had exports. */
  const policyService = require("./policy.service");
  const { policy } = await policyService.getPolicy(ctx);
  const ratePercent = policy?.legacyContingencyRatePercent;
  const basis = policy?.legacyContingencyBasis;
  const present = (v) => v !== null && v !== undefined && v !== "";
  if (!present(ratePercent) && !present(basis)) {
    return {
      source: "LEGACY_COSTING_POLICY", available: false,
      contingency: null, basisDropped: null,
    };
  }
  const chargeable = present(basis) && boardPolicy.CONTINGENCY_BASES.includes(String(basis));
  return {
    source: "LEGACY_COSTING_POLICY",
    available: true,
    contingency: {
      mode: "APPLY",
      ...(present(ratePercent) ? { ratePercent: String(ratePercent) } : {}),
      ...(chargeable ? { basis: String(basis) } : {}),
    },
    /* Named, not silently omitted: the Board is told which basis was carried
       on this record and why it cannot be ratified as it stands. */
    basisDropped: present(basis) && !chargeable ? String(basis) : null,
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, CODES,
  decisionOf, resolveFor, overlayFor, freeze, workingsFrom, legacySeed,
};
