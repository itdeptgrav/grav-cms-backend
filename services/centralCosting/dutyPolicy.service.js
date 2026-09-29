// services/centralCosting/dutyPolicy.service.js
//
// WHAT THE COMPANY PAYS TO BRING IMPORTED GOODS IN.
//
// ── THREE DESKS, AND A COSTING NEEDS ALL THREE ──────────────────────────────
//   Store  whether these goods are imported, and from where — on the
//          quotation, because the same fabric may be quoted by a local mill
//          and by an importer.
//   Item   the customs tariff classification, on the item master, because a
//          heading belongs to the goods rather than to one offer.
//   Board  what that heading and origin attract — the approved duty table.
//
// A line missing any one of them is blocked naming the desk that holds it.
// None is ever inferred from the others, and in particular:
//
//   · the HSN on a quotation is a GST classification, not a customs heading;
//   · a supplier's address is where the SUPPLIER is;
//   · an item's category says nothing about its heading.
//
// ── THE ASSESSABLE BASE, AND ITS LIMIT, STATED PLAINLY ──────────────────────
// Duty is charged here on the QUOTATION-BACKED PURCHASE AMOUNT of the imported
// line — the selected supplier's rate times the consumption times the run.
//
// That is NOT the statutory customs assessable value, which is the CIF value
// plus landing charges. This system records none of the parts that would make
// CIF computable:
//
//   · inbound freight has no source at all — there is no inbound rate
//     register, and the outbound one is a different lane and carrier;
//   · no insurance figure is recorded anywhere;
//   · there is no exchange-rate source, so a foreign invoice value could only
//     be converted by guessing;
//   · no preferential-origin certificate is recorded as a value, only as a
//     free-text note a person cites.
//
// Inventing any of those would produce a confident number with no evidence
// behind it. So the base is the one the contract can prove, every frozen
// version says which base it used, and the gap is reported rather than filled.
"use strict";

const boardPolicy = require("../board/boardPolicy.service");
const { Decimal, roundMinor } = require("./decimal");

const POLICY_KEY = "DUTY_POLICY";

const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company customs duty table" },
  STORE: { department: "Store / Purchase", system: "Supplier quotation sourcing evidence" },
});

/**
 * WHAT A LINE'S CUSTOMS POSITION IS — nine answers, not two.
 *
 * The generic "no duty source exists" this replaces told every company the
 * same thing whatever its actual situation. These say which fact is missing
 * and whose it is, which is the difference between a dead end and a task.
 */
const STATE = Object.freeze({
  /* Answers. */
  NOT_APPLICABLE: "NOT_APPLICABLE",       // Store says domestic
  APPLIED: "APPLIED",                     // one rule matched, duty calculated
  ZERO_RATED: "ZERO_RATED",               // one rule matched, and it says 0%
  /* Blockers, by owner. */
  SOURCING_TYPE_MISSING: "SOURCING_TYPE_MISSING",
  ORIGIN_MISSING: "ORIGIN_MISSING",
  TARIFF_CODE_MISSING: "TARIFF_CODE_MISSING",
  DUTY_INCLUSION_UNKNOWN: "DUTY_INCLUSION_UNKNOWN",
  POLICY_MISSING: "POLICY_MISSING",
  NO_MATCHING_RULE: "NO_MATCHING_RULE",
  AMBIGUOUS_RULES: "AMBIGUOUS_RULES",
});

/** States that stop the line being costed. */
const BLOCKING = Object.freeze([
  STATE.SOURCING_TYPE_MISSING, STATE.ORIGIN_MISSING, STATE.TARIFF_CODE_MISSING,
  STATE.DUTY_INCLUSION_UNKNOWN, STATE.POLICY_MISSING, STATE.NO_MATCHING_RULE,
  STATE.AMBIGUOUS_RULES,
]);

const str = (v) => String(v ?? "").trim();
const up = (v) => str(v).toUpperCase();
const present = (v) => v !== null && v !== undefined && v !== "";

/** The table in force, adapted to one shape. Inactive rules are excluded. */
function tableOf(policy = null) {
  const rows = Array.isArray(policy?.dutyRules) ? policy.dutyRules : [];
  return rows.filter((r) => r.active !== false);
}

/**
 * Every rule matching this heading, origin and date.
 *
 * ── EXACT, AND RETURNING ALL OF THEM ────────────────────────────────────────
 * Exact on both keys: no prefix matching on headings and no "rest of world"
 * fallback, because both are real customs concepts that need evidence this
 * system does not record.
 *
 * Returning ALL matches rather than the first is what makes ambiguity
 * reportable. The write-time overlap check should make two matches impossible;
 * this is the second guard, because a table written before that check existed
 * could still hold one — and picking one silently would make "which rate did
 * this costing use" unanswerable.
 */
function rulesMatching(table, { customsTariffCode, countryOfOrigin, asOf }) {
  const code = up(customsTariffCode);
  const origin = up(countryOfOrigin);
  const when = asOf instanceof Date ? asOf : new Date(asOf);
  return table.filter((r) => {
    if (up(r.customsTariffCode) !== code) return false;
    if (up(r.countryOfOrigin) !== origin) return false;
    const from = r.effectiveFrom ? new Date(r.effectiveFrom) : null;
    const to = r.effectiveTo ? new Date(r.effectiveTo) : null;
    if (!from || from.getTime() > when.getTime()) return false;
    /* Half-open `[from, to)`, like every other dated period here. */
    if (to && to.getTime() <= when.getTime()) return false;
    return true;
  });
}

/**
 * ONE LINE'S CUSTOMS POSITION.
 *
 * Pure and exported, so every branch is exercised without a database.
 *
 * @param {object} evidence  Store's assessment for this item — `sourcingType`,
 *   `countryOfOrigin`, `customsTariffCode`, `dutyInQuotedRate`, `quotation`.
 * @param {object|null} policy  the Board version in force, or null.
 */
function positionFor(evidence = {}, policy = null, { asOf = new Date() } = {}) {
  const type = up(evidence.sourcingType);
  const base = {
    customsTariffCode: up(evidence.customsTariffCode) || null,
    countryOfOrigin: up(evidence.countryOfOrigin) || null,
    rule: null,
    ratePercent: null,
  };

  if (!type) {
    return {
      ...base,
      state: STATE.SOURCING_TYPE_MISSING,
      owner: OWNER.STORE,
      blocking: true,
      message: "Nobody has said whether these goods are bought in India or imported. "
        + "An unanswered question is not a domestic supply, and it is not duty-free.",
    };
  }

  if (type === "DOMESTIC") {
    /* ── AN ANSWER, AND THE ONLY ROUTE TO NOT-APPLICABLE ────────────────
       No customs entry means no duty and no heading to look up. Store decided
       it and it traces to a quotation, which is exactly what separates it from
       an item nobody has looked at. */
    return {
      ...base,
      state: STATE.NOT_APPLICABLE,
      owner: null,
      blocking: false,
      message: "Bought in India — no customs entry, so no duty.",
    };
  }

  /* Imported. Both Store facts are needed: the origin decides WHICH duty and
     the heading decides WHAT duty. One without the other prices nothing. */
  if (!base.countryOfOrigin) {
    return {
      ...base,
      state: STATE.ORIGIN_MISSING,
      owner: OWNER.STORE,
      blocking: true,
      message: "Imported goods need a country of origin — duty depends on where they came from. "
        + "The supplier's address is where the supplier is, not where the goods were made.",
    };
  }
  if (!base.customsTariffCode) {
    return {
      ...base,
      state: STATE.TARIFF_CODE_MISSING,
      owner: OWNER.STORE,
      blocking: true,
      message: "This item has no customs tariff classification on the item master. The GST HSN on the "
        + "quotation is a different classification and is not one.",
    };
  }

  /* ── AND WHETHER THE QUOTED RATE ALREADY CARRIES IT ──────────────────
     Nothing in this system recorded that before. `freightTerms` says whether
     the rate delivers to our warehouse, which is a statement about freight and
     not about duty. Charging duty on top of a rate that already includes it
     would overstate every imported metre; assuming it does not would be the
     same guess in the other direction. So it is asked. */
  const inclusion = up(evidence.dutyInQuotedRate);
  if (!inclusion) {
    return {
      ...base,
      state: STATE.DUTY_INCLUSION_UNKNOWN,
      owner: OWNER.STORE,
      blocking: true,
      message: "Nobody has recorded whether this supplier's quoted rate already includes customs duty. "
        + "Adding duty to a rate that includes it would charge it twice; assuming it does not would "
        + "be the same guess the other way.",
    };
  }
  if (inclusion === "INCLUDED") {
    /* An ANSWER, and no separate line: the duty is already inside the rate the
       material line is priced from. Recorded so a reader can see it was
       considered rather than omitted. */
    return {
      ...base,
      state: STATE.NOT_APPLICABLE,
      owner: null,
      blocking: false,
      message: "The supplier's quoted rate already includes customs duty, so it is not added again.",
      dutyInQuotedRate: "INCLUDED",
    };
  }

  if (!policy) {
    return {
      ...base,
      state: STATE.POLICY_MISSING,
      owner: OWNER.BOARD,
      blocking: true,
      message: "The Board has not approved a customs duty table, so imported goods have no rate. "
        + "That is an unanswered question, not a duty of nil.",
    };
  }

  const matches = rulesMatching(tableOf(policy), {
    customsTariffCode: base.customsTariffCode,
    countryOfOrigin: base.countryOfOrigin,
    asOf,
  });

  if (matches.length === 0) {
    return {
      ...base,
      state: STATE.NO_MATCHING_RULE,
      owner: OWNER.BOARD,
      blocking: true,
      message: `The Board's duty table has no rule in force for ${base.customsTariffCode} from `
        + `${base.countryOfOrigin}. A missing rule is not a rate of nil — if these goods genuinely `
        + "attract no duty, that is approved as an explicit 0% rule.",
    };
  }
  if (matches.length > 1) {
    return {
      ...base,
      state: STATE.AMBIGUOUS_RULES,
      owner: OWNER.BOARD,
      blocking: true,
      candidateKeys: matches.map((r) => r.key),
      message: `${matches.length} duty rules apply to ${base.customsTariffCode} from `
        + `${base.countryOfOrigin} on this date. A costing cannot say which rate it used.`,
    };
  }

  const rule = matches[0];
  const zero = new Decimal(rule.ratePercent).isZero();
  return {
    ...base,
    /* ── ZERO IS ITS OWN STATE ────────────────────────────────────────
       "The Board checked and this attracts nothing" is a different record from
       "no rule exists", and a reader must be able to tell them apart a year
       later. The line total is the same; the evidence is not. */
    state: zero ? STATE.ZERO_RATED : STATE.APPLIED,
    owner: null,
    blocking: false,
    rule: {
      key: rule.key,
      label: rule.label || "",
      customsTariffCode: up(rule.customsTariffCode),
      countryOfOrigin: up(rule.countryOfOrigin),
      effectiveFrom: rule.effectiveFrom || null,
      effectiveTo: rule.effectiveTo || null,
    },
    ratePercent: rule.ratePercent,
    dutyInQuotedRate: "EXCLUDED",
    message: zero
      ? `Approved at 0% for ${base.customsTariffCode} from ${base.countryOfOrigin}.`
      : `${rule.ratePercent}% of the purchase amount, for ${base.customsTariffCode} from `
        + `${base.countryOfOrigin}.`,
  };
}

/**
 * The duty on one scenario's purchase amount.
 *
 * ── EXACT DECIMAL, ROUNDED ONCE ─────────────────────────────────────────────
 * Computed on the RUN total for the scenario rather than per garment and
 * multiplied, so 500 units cannot accumulate 500 roundings. The same
 * discipline the rest of the engine uses.
 */
function dutyMinorOn(basisAmountMinor, ratePercent, { roundingMode = "HALF_UP" } = {}) {
  if (!present(basisAmountMinor) || !present(ratePercent)) return null;
  const exact = new Decimal(basisAmountMinor).times(new Decimal(ratePercent)).dividedBy(100);
  return roundMinor(exact, roundingMode);
}

/** The table in force for this company on this costing's date. */
async function resolveFor(ctx, { asOf = new Date() } = {}) {
  const policy = await boardPolicy
    .resolveEffective(ctx.companyId, POLICY_KEY, asOf)
    .catch(() => null);
  return {
    policy: policy || null,
    state: policy ? "APPLIED" : STATE.POLICY_MISSING,
    rules: tableOf(policy),
  };
}

/**
 * What a version freezes about the DECISION behind a duty line.
 *
 * The per-scenario working is frozen beside it by the assembly; this is the
 * identity half — which approved table, which rule, whose evidence.
 */
function freeze({ resolved, position, evidence = {}, scenarios = [], asOf = new Date() }) {
  const policy = resolved?.policy || null;
  return {
    state: position?.state || STATE.POLICY_MISSING,
    boardPolicyId: policy?._id || null,
    policyKey: POLICY_KEY,
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    ruleKey: position?.rule?.key || null,
    ruleLabel: position?.rule?.label || "",
    ruleEffectiveFrom: position?.rule?.effectiveFrom || null,
    ruleEffectiveTo: position?.rule?.effectiveTo || null,
    customsTariffCode: position?.customsTariffCode || null,
    countryOfOrigin: position?.countryOfOrigin || null,
    ratePercent: position?.ratePercent ?? null,
    /* ── WHICH BASE, SAID ON THE RECORD ───────────────────────────────
       Not the statutory CIF assessable value — see the header. A version that
       did not say so could be misread years later as a customs computation. */
    assessableBasis: "QUOTATION_PURCHASE_AMOUNT",
    /* Store's evidence, identified so the claim traces to paper. Never the
       supplier's rate — that is commercial, and the amount below is what a
       reader needs. */
    offerId: evidence?.quotation?.offerId || null,
    offerReference: evidence?.quotation?.reference || "",
    offerRevision: evidence?.quotation?.revision ?? null,
    dutyInQuotedRate: position?.dutyInQuotedRate || null,
    /* The reason, in the words the Board screen and the costing use. An entry
       that charged nothing needs it most: `NOT_APPLICABLE` alone does not say
       whether the goods were domestic or arrived at a duty-paid price. */
    note: position?.message || "",
    scenarios,
    asOf,
  };
}

module.exports = {
  POLICY_KEY, OWNER, STATE, BLOCKING,
  tableOf, rulesMatching, positionFor, dutyMinorOn, resolveFor, freeze,
};
