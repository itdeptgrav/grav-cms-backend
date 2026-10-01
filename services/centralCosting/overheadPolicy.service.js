// services/centralCosting/overheadPolicy.service.js
//
// WHAT THE COMPANY ADDS TO EVERY GARMENT TO COVER WHAT IT COSTS TO RUN.
//
// ── WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ─────────────────────────────
// The arithmetic did not change at all. Overhead is still a percentage of a
// named costing subtotal, still synthesised by the engine as its own
// `PERCENT_OF_BASIS` line, still ordered by the same basis graph. A costing
// recalculated the day after this landed produces the same figure it did the
// day before, given the same rate and basis.
//
// What changed is where the rate comes FROM. It was two fields on the mutable
// `CostingPolicy` row — no draft, no approver, no effective date, no history,
// so raising it took effect the instant somebody pressed save and the previous
// value was gone. It is now an approved, effective-dated `BoardPolicy` version,
// resolved against the COSTING'S OWN DATE.
//
// ── AND THE COMBINED MEANING IS PRESERVED ───────────────────────────────────
// One rate, named "Company and factory overhead", exactly as before. Splitting
// the company pool from the factory pool would mean inventing an allocation
// nobody in this repository has computed and then asking the Board to approve
// it — a costing decision with its own evidence, not a side effect of
// governing a rate that already exists.
//
// ── MISSING IS MISSING ──────────────────────────────────────────────────────
// A company whose Board has approved nothing has NO overhead line and its
// costings say so. Never a 0% rate, which would read as "this company costs
// nothing to run" — a claim nobody made.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");

const POLICY_KEY = "OVERHEAD";
const LINE_KEY = "policy:overhead";

/** Whose gap it is. One owner, unlike financing — there is no operational half. */
const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company overhead policy" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "OVERHEAD_POLICY_MISSING",
});

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * The rule in force for a company on a date, reduced to what a calculation
 * needs. Pure: the caller supplies the resolved version.
 *
 * @param {object|null} policy  an effective `BoardPolicy` document, or null
 * @returns {object} `{ state, ratePercent, basis, missing }` — `ratePercent`
 *   and `basis` are null unless BOTH are stated, because a rate with no basis
 *   is a percentage of something unstated and applies to nothing.
 */
function methodologyOf(policy = null) {
  const o = policy?.overhead || {};
  const complete = present(o.ratePercent) && Boolean(o.basis);
  if (!complete) {
    return {
      state: STATE.POLICY_MISSING,
      ratePercent: null,
      basis: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: policy
          ? "The Board's overhead policy in force does not state both a rate and the subtotal it applies to, so overhead cannot be calculated."
          : "The Board has not approved an overhead policy for this company, so the garment carries none of what the company costs to run. It is not nil.",
      }],
    };
  }
  return {
    state: STATE.APPLIED,
    ratePercent: o.ratePercent,
    basis: o.basis,
    missing: [],
  };
}

/**
 * The overhead rule for this company on this costing's date.
 *
 * Resolved against the COSTING'S OWN date, never against now: a costing dated
 * in March is calculated at March's rate, and a policy approved since — even
 * one backdated — is simply not the version this query selects.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return { policy: policy || null, ...methodologyOf(policy) };
}

/**
 * The two fields the engine reads, as an overlay on the policy object.
 *
 * ── WHY AN OVERLAY AND NOT AN ENGINE CHANGE ─────────────────────────────────
 * `engine.js` synthesises the overhead line from `policy.overheadRatePercent`
 * and `policy.overheadBasis`. Keeping that shape and changing only what fills
 * it means the basis graph, the ordering, the rounding and the arithmetic are
 * untouched by this migration — there is no version of this change where the
 * engine had to be re-read to be sure the number still comes out the same.
 *
 * The legacy fields are dropped rather than fallen back to. An unapproved
 * value applied under a Board-governed family would be that value being
 * treated as Board-approved, which is the one thing this migration must not
 * do — see `POLICY_OVERHEAD_RETIRED` in policy.service.
 */
function overlayFor(resolved) {
  if (resolved?.state !== STATE.APPLIED) {
    return { overheadRatePercent: undefined, overheadBasis: undefined };
  }
  return { overheadRatePercent: resolved.ratePercent, overheadBasis: resolved.basis };
}

/**
 * What gets frozen onto the version.
 *
 * ── THE FIGURE AND WHAT IT WAS A PERCENTAGE OF ──────────────────────────────
 * A rate and a basis NAME are not enough to check an overhead figure a year
 * later: `SUBTOTAL_BEFORE_OVERHEAD` is a computed amount that depends on every
 * other line on the version. So the amount it was applied to is frozen beside
 * the amount it produced, per scenario — 12% of what, coming to what.
 *
 * The Board's decision is copied by VALUE, not referenced. `boardPolicyId` is
 * there so the decision can be found; every figure beside it is there so the
 * calculation can be checked without finding it, and so that a policy approved
 * next quarter — or one backdated — cannot restate a costing already frozen.
 */
function freeze({ resolved, calculated = null, asOf = new Date() }) {
  const policy = resolved?.policy || null;
  return {
    lineKey: LINE_KEY,
    state: resolved?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    ratePercent: resolved?.ratePercent ?? null,
    basis: resolved?.basis || null,
    /* One working per scenario: the same rate on the same basis produces
       different money at 500 garments and at 3,000, and each is shown as it
       was arrived at. */
    scenarios: scenarioWorkings(calculated),
    asOf,
  };
}

/**
 * What the overhead line came to on each scenario, and what it was applied to.
 *
 * Read off the engine's own result rather than recomputed — a second
 * calculation is a second answer, and the version would be provenanced with
 * one and calculated from the other.
 */
function scenarioWorkings(calculated) {
  const scenarios = calculated?.scenarios || [];
  const out = [];
  for (const s of scenarios) {
    const line = (s.lines || []).find((l) => l.lineKey === LINE_KEY);
    if (!line) continue;
    out.push({
      scenarioKey: s.key || s.scenarioKey || null,
      quantity: s.quantity ?? null,
      /* What the percentage was OF. `basisAmountMinor` is the figure a reader
         needs to re-do the arithmetic and is not otherwise recoverable from
         the version: it is a subtotal across a category set, not a line. */
      basisAmountMinor: line.basisAmountMinor ?? null,
      overheadMinor: line.totalMinor ?? null,
      perUnitMinor: line.perUnitMinor ?? null,
    });
  }
  return out.length ? out : undefined;
}

module.exports = {
  POLICY_KEY, LINE_KEY, OWNER, STATE, CODES,
  methodologyOf, resolveFor, overlayFor, freeze, scenarioWorkings,
};
