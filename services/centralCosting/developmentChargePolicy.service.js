// services/centralCosting/developmentChargePolicy.service.js
//
// WHAT THE COMPANY CHARGES FOR DEVELOPMENT WORK IT DOES ITSELF.
//
// ── TWO SOURCES, AND THIS IS ONLY ONE OF THEM ───────────────────────────────
// A development requirement is priced one of two ways, and Merchandising says
// which when it records the row:
//
//   SUPPLIER_QUOTATION  bought outside. Store's service quotation register
//                       prices it, exactly as it prices an outside process.
//                       Untouched by this module.
//   COMPANY_POLICY      done in-house. There is no supplier and no quotation,
//                       so the only thing that can price it is a charge the
//                       company published — which is what this resolves.
//
// ── TWO LAYERS OF DATING, AND BOTH ARE LOAD-BEARING ─────────────────────────
// The Board VERSION's `effectiveFrom` selects which catalogue is company
// policy on the costing's date. Each charge's own `rates[]` periods select
// which rate inside that catalogue applies on the same date.
//
//   · drop the outer layer and adding a charge would apply to every costing
//     ever recalculated;
//   · drop the inner one and publishing October's rate would re-price a
//     costing already approved at September's — the exact defect `rates[]`
//     was introduced to fix.
//
// ── AND THE ARITHMETIC IS NOT HERE ──────────────────────────────────────────
// `developmentCharges.js` owns `selectPeriod` and `chargeTotalMinor`, and its
// period rules and exact-decimal handling are correct. This module supplies
// the CATALOGUE that module reads; it does not re-implement any of it.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");
const { adaptTable } = require("./developmentCharges");

const POLICY_KEY = "DEVELOPMENT_CHARGE_POLICY";

const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company development charge catalogue" },
});

const STATE = Object.freeze({
  APPLIED: "APPLIED",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "DEVELOPMENT_POLICY_MISSING",
});

/**
 * The catalogue in force, in the shape everything downstream reads.
 *
 * ── AN EMPTY CATALOGUE IS AN ANSWER; NO POLICY IS NOT ───────────────────────
 * A company that does no development work itself may legitimately approve a
 * catalogue with nothing in it, and a requirement naming a charge then gets
 * "no charge is configured under that key" — a real, specific refusal.
 *
 * A company with NO approved policy is a different thing: nobody has decided
 * what the company charges for its own work, and the refusal names the Board
 * rather than a missing key.
 */
function catalogueOf(policy = null) {
  if (!policy) {
    return {
      state: STATE.POLICY_MISSING,
      charges: [],
      missing: [{
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: "The Board has not approved a development charge catalogue for this company, so work "
          + "the company does itself has no cost source. It is not free.",
      }],
    };
  }
  return {
    state: STATE.APPLIED,
    /* Adapted, so a charge carried over from the retired flat shape is read as
       the one rate period it always was rather than being invisible. */
    charges: adaptTable(policy.developmentCharges),
    missing: [],
  };
}

/**
 * The catalogue for this company on this costing's date.
 *
 * The OUTER dating layer. Against the costing's own date, never against now:
 * a costing dated in March reads March's approved catalogue, and a policy
 * approved since — even one backdated — is simply not the version this query
 * selects.
 */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return { policy: policy || null, ...catalogueOf(policy) };
}

/**
 * The one name the assembly and the Merchandising projection read.
 *
 * ── WHY AN OVERLAY AND NOT A CHANGE TO THE RESOLVER ─────────────────────────
 * `applyDevelopmentCharges` reads `policy.developmentCharges`, adapts it,
 * selects the period and prices the requirement. All of that is correct and
 * stays. Filling that one name from the Board's approved version instead of
 * from the mutable costing policy leaves the period rules, the four typed
 * refusals and the arithmetic untouched.
 *
 * A missing policy overlays `undefined` rather than an empty array: an empty
 * table means "the company configured none", which is a different answer from
 * "nobody has decided", and the assembly's own message already tells them
 * apart.
 */
function overlayFor(resolved) {
  return {
    developmentCharges: resolved?.state === STATE.APPLIED ? resolved.charges : undefined,
  };
}

/**
 * WHAT MERCHANDISING MAY SEE.
 *
 * Identity and shape — enough to choose a charge and know whether a count is
 * needed. Never the rate, never the periods, never a total.
 *
 * Inactive charges are dropped rather than flagged: this list is what a person
 * PICKS from, and a retired charge is not pickable. A requirement already
 * pointing at one is reported separately, by key, so it stays explainable and
 * asks for a deliberate replacement.
 */
function catalogueForMerchandising(resolved) {
  const out = new Map();
  for (const def of resolved?.charges || []) {
    if (def.active === false) continue;
    out.set(def.key, {
      key: def.key,
      label: def.label,
      /* Published because it is what tells a merchandiser which charge they
         actually want — and it carries no money. */
      description: def.description || "",
      /* WHETHER a count is needed, never what it costs. */
      calculation: def.calculation,
      unit: def.unit || null,
    });
  }
  return out;
}

/**
 * What gets frozen onto the version, about the DECISION.
 *
 * The per-line charge working is already frozen by `applyDevelopmentCharges`
 * into `policyProvenance` — key, label, calculation, unit, quantity, unit
 * amount, total, currency and the SELECTED rate period. What no version could
 * say is which approved catalogue that charge was read from, and who approved
 * it. This is that half.
 */
function freeze({ resolved, asOf = new Date() }) {
  const policy = resolved?.policy || null;
  return {
    state: resolved?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    /* How many charges the approved catalogue held. Not the catalogue itself:
       the version froze the charge it USED, and copying every rate the company
       publishes onto every costing would be a rate card on a garment. */
    chargeCount: (resolved?.charges || []).length,
    asOf,
  };
}

/**
 * The retired costing-policy table, in the shape a Board draft takes.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * Companies already have charges configured, requirements already point at
 * their keys, and frozen costings already name them. The migration stops those
 * amounts being APPLIED — nobody approved them — but re-typing them into the
 * Board's first draft by hand would mint new keys and orphan every stored
 * requirement, so the keys have to travel.
 *
 * What does NOT travel is any suggestion that they are settled. This returns
 * material for a DRAFT. It approves nothing, it dates nothing, and the Board
 * has to look at each charge and say yes.
 */
async function legacySeed(ctx) {
  /* Required lazily: `policy.service` requires this module, and requiring it
     back at load time would close the cycle before either had exports. */
  const policyService = require("./policy.service");
  const { policy } = await policyService.getPolicy(ctx);
  const charges = adaptTable(policy?.legacyDevelopmentCharges);
  return {
    source: "LEGACY_COSTING_POLICY",
    count: charges.length,
    charges: charges.map((c) => ({
      /* The key, unchanged and deliberately. It is the only field here that
         anything else in the system points at. */
      key: c.key,
      label: c.label,
      description: c.description || "",
      calculation: c.calculation || "FLAT_PER_RUN",
      ...(c.unit ? { unit: c.unit } : {}),
      active: c.active !== false,
      rates: (c.rates || []).map((r) => ({
        amountMinor: r.amountMinor,
        currency: r.currency || "INR",
        effectiveFrom: r.effectiveFrom,
        ...(r.effectiveTo ? { effectiveTo: r.effectiveTo } : {}),
      })),
    })),
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, CODES,
  catalogueOf, resolveFor, overlayFor, catalogueForMerchandising, freeze, legacySeed,
};
