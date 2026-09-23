// services/centralCosting/labourPolicy.service.js
//
// WHAT A MINUTE OF SEWING COSTS — THE HALF THE BOARD DECIDES.
//
// ── WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ─────────────────────────────
// The arithmetic did not change and is not in this file. `labourCost.js` is
// still the single labour authority: employer cost, productive minutes, cost
// per minute, cost per garment, exact decimal, one rounding point. It reads
// four names off the policy object it is handed, and this module decides what
// fills them.
//
// They used to be four fields on the mutable `CostingPolicy` row — no draft,
// no approver, no effective date, no history. They are now an approved,
// effective-dated `BoardPolicy` version resolved against the costing's own
// date, exactly as overhead and financing are.
//
// ── PRODUCTION STILL OWNS THE OTHER HALF ────────────────────────────────────
// The route, the SAM, and which salary basis an operation is paid at are
// Production's, and nothing here reads or reports them. What the Board decides
// is how a PAID month becomes a productive one, what an operator costs beyond
// take-home pay, and where machine cost is accounted for.
//
// ── AND THE FAILURES ARE KEPT APART ─────────────────────────────────────────
// "Labour unavailable" is one phrase for eight different situations with four
// different owners. A company with no Board policy, one whose Board chose
// `IN_OPERATION_RATE` with no machine master to point at, one whose overhead
// policy has lapsed, and one whose R&D record has no SAM are each fixed by a
// different person in a different app. Collapsing them sends everybody to the
// wrong desk.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");

const POLICY_KEY = "LABOUR_METHODOLOGY";

/** Whose gap it is. Three owners, because labour genuinely has three. */
const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company labour methodology" },
  PRODUCTION: { department: "Production", system: "Operation route and salary basis" },
  UNASSIGNED: { department: "Not yet assigned", system: "No machine-cost source exists" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  POLICY_MISSING: "POLICY_MISSING",
});

/**
 * Why labour cannot be costed, kept apart rather than collapsed.
 *
 * The first is the Board's; the next two are downstream DEPENDENCIES a valid
 * Board decision can still leave open; the last two are Production's.
 */
const CODES = Object.freeze({
  POLICY_MISSING: "LABOUR_POLICY_MISSING",
  MACHINE_SOURCE_MISSING: "MACHINE_COST_SOURCE_MISSING",
  OVERHEAD_DEPENDENCY_MISSING: "MACHINE_OVERHEAD_DEPENDENCY_MISSING",
  SAM_MISSING: "SAM_NOT_RECORDED",
  SALARY_BASIS_MISSING: "SALARY_BASIS_UNRESOLVED",
});

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * The rule in force, reduced to what a calculation needs. Pure.
 *
 * Complete means the same thing `labourCost.js` means by it: exactly one
 * productive basis, a stated employer burden, and a machine treatment. A
 * partially stated methodology is not a cheaper one — it is a company that has
 * not decided, and `labourCost` refuses rather than guessing.
 */
function methodologyOf(policy = null) {
  const l = policy?.labour || {};
  const hasMinutes = present(l.productiveMinutesPerMonth);
  const hasEfficiency = present(l.labourEfficiencyPercent);
  const oneBasis = hasMinutes !== hasEfficiency;
  const complete = oneBasis && present(l.employerBurdenPercent) && Boolean(l.machineBurdenTreatment);

  if (!complete) {
    return {
      state: STATE.POLICY_MISSING,
      labour: null,
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: policy
          ? "The Board's labour methodology in force is incomplete, so an operation's cost cannot be worked out."
          : "The Board has not approved a labour methodology for this company, so a minute of an operator's "
            + "time has no cost. It is not the operator's take-home pay.",
      }],
    };
  }
  return {
    state: STATE.APPLIED,
    labour: {
      productiveMinutesPerMonth: hasMinutes ? l.productiveMinutesPerMonth : undefined,
      labourEfficiencyPercent: hasEfficiency ? l.labourEfficiencyPercent : undefined,
      employerBurdenPercent: l.employerBurdenPercent,
      machineBurdenTreatment: l.machineBurdenTreatment,
      machineExclusionReason: l.machineExclusionReason || "",
    },
    missing: [],
  };
}

/**
 * The labour rule for this company on this costing's date.
 *
 * Resolved against the COSTING'S OWN date, never against now: a costing dated
 * in March is calculated at March's methodology, and a policy approved since —
 * even one backdated — is simply not the version this query selects.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return { policy: policy || null, ...methodologyOf(policy) };
}

/**
 * The four names `labourCost.js` reads, as an overlay on the policy object.
 *
 * ── WHY AN OVERLAY AND NOT A CHANGE TO `labourCost.js` ──────────────────────
 * That module is the single labour authority and its arithmetic is correct.
 * Keeping its input shape and changing only what fills it means the formula,
 * the decimal handling and the rounding point are untouched by this
 * migration — there is no version of this change where the arithmetic had to
 * be re-read to be sure a garment still costs the same.
 *
 * The legacy fields are dropped rather than fallen back to. An unapproved
 * value applied under a Board-governed family would be that value being
 * treated as Board-approved.
 */
function overlayFor(resolved) {
  if (resolved?.state !== STATE.APPLIED) {
    return {
      productiveMinutesPerMonth: undefined,
      labourEfficiencyPercent: undefined,
      employerBurdenPercent: undefined,
      machineBurdenTreatment: undefined,
    };
  }
  const l = resolved.labour;
  return {
    productiveMinutesPerMonth: l.productiveMinutesPerMonth,
    labourEfficiencyPercent: l.labourEfficiencyPercent,
    employerBurdenPercent: l.employerBurdenPercent,
    machineBurdenTreatment: l.machineBurdenTreatment,
  };
}

/**
 * WHAT A VALID BOARD DECISION CAN STILL LEAVE OPEN.
 *
 * ── AN APPROVED METHODOLOGY IS NOT ALWAYS A COMPLETE ONE ────────────────────
 * The Board may legitimately approve `IN_OPERATION_RATE` before anybody has
 * built a machine-cost master, and `IN_OVERHEAD` before the overhead policy is
 * in force. Both are real decisions and neither is wrong; what would be wrong
 * is reporting the family as answered because an enum has a value in it.
 *
 * So the dependency is reported separately from the policy, with the owner who
 * can actually close it — which for the machine source is nobody yet, and
 * saying so is more honest than naming a department that has no such record.
 *
 * @param {object} resolved         from `resolveFor`
 * @param {boolean} overheadInForce whether the Board's overhead policy applies
 */
function dependenciesOf(resolved, { overheadInForce = false } = {}) {
  if (resolved?.state !== STATE.APPLIED) return [];
  const treatment = resolved.labour.machineBurdenTreatment;

  if (treatment === "IN_OPERATION_RATE") {
    return [{
      code: CODES.MACHINE_SOURCE_MISSING,
      owner: OWNER.UNASSIGNED,
      treatment,
      message: "Machine cost is set to sit inside the operation rate, and no machine-cost source exists "
        + "to put there. Nothing in this system records a machine hourly rate, a depreciation schedule "
        + "or a power rate. The fix is a Production master, not a policy edit.",
    }];
  }
  if (treatment === "IN_OVERHEAD" && !overheadInForce) {
    return [{
      code: CODES.OVERHEAD_DEPENDENCY_MISSING,
      owner: OWNER.BOARD,
      treatment,
      message: "Machine cost is charged through overhead, and the Board has no overhead policy in force — "
        + "so it is charged nowhere. Approve an overhead policy, or account for machine cost elsewhere.",
    }];
  }
  /* NOT_COSTED depends on nothing: it is the decision that machine cost is
     carried nowhere, and the version keeps the reason. */
  return [];
}

/**
 * What gets frozen onto the version.
 *
 * ── THE RULE, AND WHAT IT RESOLVED TO ───────────────────────────────────────
 * An efficiency is not a denominator. `80%` and `9,984 minutes` are the same
 * decision and only the second is what the arithmetic divided by, so both are
 * frozen — the method the Board chose, and the number it came to.
 *
 * Copied by VALUE. `boardPolicyId` is there so the decision can be found;
 * every figure beside it is there so the calculation can be checked without
 * finding it, and so a policy approved next quarter cannot restate a costing
 * frozen before it.
 */
function freeze({ resolved, productiveMinutesResolved = null, dependencies = [], asOf = new Date() }) {
  const policy = resolved?.policy || null;
  const l = resolved?.labour || {};
  return {
    state: resolved?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",

    /* The method, and the minutes it produced. */
    productiveBasis: present(l.productiveMinutesPerMonth) ? "STATED_MINUTES" : "EFFICIENCY",
    productiveMinutesPerMonth: l.productiveMinutesPerMonth ?? null,
    labourEfficiencyPercent: l.labourEfficiencyPercent ?? null,
    productiveMinutesResolved: productiveMinutesResolved ?? null,

    employerBurdenPercent: l.employerBurdenPercent ?? null,
    machineBurdenTreatment: l.machineBurdenTreatment || null,
    machineExclusionReason: l.machineExclusionReason || "",
    /* A dependency the approved policy still leaves open, frozen as it stood —
       so a version costed while no machine source existed says so for ever
       rather than looking complete once one is built. */
    dependencies: dependencies.length
      ? dependencies.map((d) => ({ code: d.code, message: d.message }))
      : undefined,
    asOf,
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, CODES,
  methodologyOf, resolveFor, overlayFor, dependenciesOf, freeze,
};
