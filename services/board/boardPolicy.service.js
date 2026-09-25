// services/board/boardPolicy.service.js
//
// THE LIFECYCLE OF A COMPANY-WIDE DECISION: DRAFT → APPROVED → EFFECTIVE →
// SUPERSEDED.
//
// ── THE ONE RULE EVERYTHING ELSE FOLLOWS FROM ───────────────────────────────
// An approved version is never edited and never rewritten. A change is a NEW
// version with a later effective date, and the earlier one stays exactly as it
// was approved. That is what makes "what was the rate in March" answerable
// without finding a costing frozen in March.
//
// ── RESOLUTION IS A QUERY, NOT A STATE MACHINE ──────────────────────────────
// The policy in force on a date is:
//
//     the approved version with the greatest `effectiveFrom` at or before it
//
// Which makes two of the required rules structural rather than enforced:
//
//   · a future-dated version cannot affect a calculation before its date,
//     because the query does not select it;
//   · at most one version is effective for a company on a date, because the
//     greatest qualifying date is unique — and the unique index makes sure two
//     approved versions never share one.
//
// ── AND WHY BACKDATING CANNOT RESTATE A FROZEN COSTING ──────────────────────
// Nothing here protects that, and nothing here needs to. A `CostingVersion`
// COPIES the resolved policy into `financingProvenance` at freeze time and
// reads the copy for ever after. Approving a version dated last January
// changes what the NEXT costing resolves; a costing already frozen never asks
// again. The guarantee is the snapshot, exactly as it already is for
// `policySnapshot` and the development-charge table.
"use strict";

const mongoose = require("mongoose");

const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const {
  ADVANCE_TREATMENTS, DAY_COUNT_BASES, FINANCING_START_EVENTS, MACHINE_BURDEN_TREATMENTS, GST_TREATMENTS,
  DEVELOPMENT_CALCULATIONS, CONTINGENCY_MODES, PAYLOAD_FIELD,
} = require("../../models/CMS_Models/Board/BoardPolicy");
/* `BASES` as well as the key list: the contingency contract classifies a
   basis by what it CONTAINS, so it must read the engine's own definition
   rather than keep a second copy that could drift from it. */
const { BASIS_KEYS, BASES: ENGINE_BASES } = require("../centralCosting/engine");
/* `Decimal` as well: the margin band is the one contract that compares its
   own figures to each other, and comparing decimal strings as numbers is how a
   band silently passes at 9 vs 10. */
const { percent, Decimal, DecimalError } = require("../centralCosting/decimal");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const present = (v) => v !== null && v !== undefined && v !== "";
const bad = (message, details) => fail("VALIDATION", message, details);

/** A date, or undefined. Refused by name rather than silently becoming today. */
function asDate(value, field) {
  if (!present(value)) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw bad("That is not a date.", { field, reason: "DATE_INVALID", value: str(value) });
  }
  return d;
}

/* ══ THE DERIVED LIFECYCLE ═════════════════════════════════════════════════ */

/**
 * What state one version is in, given the calendar and what else is approved.
 *
 * Pure and exported, so every branch is exercised without a database — a rule
 * reachable only through a route is a rule nobody checks.
 *
 * @param {object} doc      the stored version
 * @param {object} context  `{ asOf, latestEffectiveId }` — the date being asked
 *   about, and which version resolution picks for it. Passing the winner in
 *   rather than recomputing per row keeps one answer for a whole list.
 */
function lifecycleOf(doc, { asOf = new Date(), latestEffectiveId = null } = {}) {
  if (!doc || doc.status === "DRAFT") return "DRAFT";
  const from = doc.effectiveFrom ? new Date(doc.effectiveFrom) : null;
  /* Approved with no date cannot happen through this service — approval
     requires one — but a document is not a promise, and reporting it as
     EFFECTIVE would be the worst of the four available lies. */
  if (!from) return "BOARD_APPROVED";
  if (from.getTime() > new Date(asOf).getTime()) return "BOARD_APPROVED";
  if (latestEffectiveId && String(doc._id) === String(latestEffectiveId)) return "EFFECTIVE";
  /* Approved, its date has passed, and something later took over. */
  return latestEffectiveId ? "SUPERSEDED" : "EFFECTIVE";
}

/* ══ RESOLUTION ════════════════════════════════════════════════════════════ */

/**
 * The version in force for a company on a date, or null.
 *
 * `null` is the answer for a company whose Board has not decided yet, and it
 * is never turned into a zero, a default or an example. What the caller does
 * with it is the caller's business; what it must not do is calculate.
 */
async function resolveEffective(companyId, policyKey, asOf = new Date()) {
  const when = asDate(asOf, "asOf") || new Date();
  if (!companyId) return null;
  return BoardPolicy.findOne({
    companyId,
    policyKey,
    status: "BOARD_APPROVED",
    effectiveFrom: { $lte: when },
  })
    .sort({ effectiveFrom: -1, _id: -1 })
    .lean();
}

/**
 * WHY A COMPANY HAS NO POLICY IN FORCE — four different answers.
 *
 * ── WHY THIS IS NOT A BOOLEAN ───────────────────────────────────────────────
 * "No effective policy" is one word for four situations a department, and the
 * Board itself, need to tell apart:
 *
 *   EFFECTIVE   a version is in force for this date.
 *   FUTURE_ONLY approved, and its date has not arrived. Nobody has to do
 *               anything; a costing dated after it will pick it up.
 *   DRAFT_ONLY  somebody is preparing one and nobody has approved it. The act
 *               that is missing is an APPROVAL, by a named person.
 *   NONE        nothing exists. The act that is missing is the decision.
 *
 * Collapsing them sends the wrong message to the wrong desk: "the Board has
 * not decided" is untrue when a draft is sitting waiting for an approver, and
 * "waiting for approval" is untrue when nobody has written anything.
 *
 * It carries no rate, no basis and no methodology — see the departmental
 * projection, which publishes this and nothing more.
 */
const POLICY_STATE = Object.freeze({
  EFFECTIVE: "EFFECTIVE",
  FUTURE_ONLY: "FUTURE_ONLY",
  DRAFT_ONLY: "DRAFT_ONLY",
  NONE: "NONE",
});

async function resolveState(companyId, policyKey, asOf = new Date()) {
  const when = asDate(asOf, "asOf") || new Date();
  const empty = {
    state: POLICY_STATE.NONE, effective: null,
    effectiveFrom: null, approvedAt: null, approvedByName: "",
    nextEffectiveFrom: null, draftCount: 0,
  };
  if (!companyId) return empty;

  const all = await BoardPolicy.find({ companyId, policyKey })
    .select("status effectiveFrom approvedAt approvedByActorName")
    .lean()
    .catch(() => []);
  if (!all.length) return empty;

  const approved = all.filter((d) => d.status === "BOARD_APPROVED" && d.effectiveFrom);
  const inForce = approved
    .filter((d) => new Date(d.effectiveFrom) <= when)
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0] || null;
  const future = approved
    .filter((d) => new Date(d.effectiveFrom) > when)
    .sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom))[0] || null;
  const draftCount = all.filter((d) => d.status === "DRAFT").length;

  if (inForce) {
    return {
      state: POLICY_STATE.EFFECTIVE,
      effective: inForce,
      effectiveFrom: inForce.effectiveFrom || null,
      approvedAt: inForce.approvedAt || null,
      approvedByName: inForce.approvedByActorName || "",
      /* What is queued behind it, so a screen can say "changing on 1 April"
         without saying what it changes to. */
      nextEffectiveFrom: future?.effectiveFrom || null,
      draftCount,
    };
  }
  if (future) {
    return {
      ...empty,
      state: POLICY_STATE.FUTURE_ONLY,
      nextEffectiveFrom: future.effectiveFrom || null,
      draftCount,
    };
  }
  if (draftCount) return { ...empty, state: POLICY_STATE.DRAFT_ONLY, draftCount };
  return empty;
}

/* ══ THE FINANCING CONTRACT ════════════════════════════════════════════════ */

/**
 * What a financing methodology must state before it can be approved.
 *
 * Returned as a list rather than thrown one at a time: somebody completing a
 * draft should be told everything that is still open, not sent back four
 * times. Exported so the screen asks the same question the server answers.
 */
function financingGaps(financing = {}) {
  const out = [];
  if (!present(financing.annualRatePercent)) {
    out.push({ field: "annualRatePercent", message: "State the annual financing rate." });
  }
  if (!financing.basis) {
    out.push({ field: "basis", message: "State which costing subtotal financing is charged on." });
  }
  if (!financing.advanceTreatment) {
    out.push({
      field: "advanceTreatment",
      message: "State whether the customer's advance reduces the amount being financed.",
    });
  }
  if (!financing.dayCountBasis) {
    out.push({ field: "dayCountBasis", message: "State how many days the annual rate is spread over." });
  }
  /* ── AND WHEN THE WAITING STARTS ──────────────────────────────────────
     A rate and a day-count say what a day of waiting costs; they say nothing
     about when the company began waiting. Committing to fabric in January
     and shipping in March is two months of financing that committing on the
     cutting day does not carry, and no other field on this record can tell
     those two companies apart. */
  if (!financing.startEvent) {
    out.push({
      field: "startEvent",
      message: "State when the company's money goes out — financing is measured from that event to each "
        + "payment's due date.",
    });
  }
  return out;
}

/** One financing field, validated by name. Absent stays absent; wrong is refused. */
function validateFinancing(patch = {}, existing = {}) {
  const out = { ...existing };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has("annualRatePercent")) {
    const v = patch.annualRatePercent;
    if (!present(v)) out.annualRatePercent = undefined;
    else {
      try {
        /* Up to 100% a year. Above that is not a borrowing rate anybody
           agreed; it is a decimal point in the wrong place, and accepting it
           would put a garment's whole cost into its financing line. */
        out.annualRatePercent = percent(v, { field: "annualRatePercent", min: 0, max: 100 }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
    }
  }

  if (has("basis")) {
    const v = str(patch.basis);
    if (!v) out.basis = undefined;
    else if (!BASIS_KEYS.includes(v)) {
      throw bad("That is not something financing can be a percentage of.", {
        field: "basis", reason: "BASIS_UNKNOWN", allowed: BASIS_KEYS, value: v,
      });
    } else out.basis = v;
  }

  if (has("advanceTreatment")) {
    const v = str(patch.advanceTreatment);
    if (!v) out.advanceTreatment = undefined;
    else if (!ADVANCE_TREATMENTS.includes(v)) {
      throw bad("The advance either reduces the financed amount or it does not.", {
        field: "advanceTreatment", reason: "VALUE_NOT_ALLOWED", allowed: ADVANCE_TREATMENTS, value: v,
      });
    } else out.advanceTreatment = v;
  }

  if (has("startEvent")) {
    const v = str(patch.startEvent);
    if (!v) out.startEvent = undefined;
    else if (!FINANCING_START_EVENTS.includes(v)) {
      throw bad("That is not an event this company's orders record.", {
        field: "startEvent", reason: "VALUE_NOT_ALLOWED", allowed: [...FINANCING_START_EVENTS], value: v,
      });
    } else out.startEvent = v;
  }

  if (has("dayCountBasis")) {
    const v = patch.dayCountBasis;
    if (!present(v)) out.dayCountBasis = undefined;
    else {
      const n = Number(v);
      if (!DAY_COUNT_BASES.includes(n)) {
        throw bad("A year is counted as 365 days or as 360.", {
          field: "dayCountBasis", reason: "VALUE_NOT_ALLOWED", allowed: [...DAY_COUNT_BASES], value: v,
        });
      }
      out.dayCountBasis = n;
    }
  }

  return out;
}

/* ══ THE OVERHEAD CONTRACT ═════════════════════════════════════════════════ */

/**
 * What an overhead methodology must state before it can be approved.
 *
 * Two questions, and the second is the one that used to get lost: a rate with
 * no basis is a percentage of something unstated, which is not a rule. The
 * legacy costing policy enforced the same pair; what is new is that somebody
 * approves it and says when it starts.
 */
function overheadGaps(overhead = {}) {
  const out = [];
  if (!present(overhead.ratePercent)) {
    out.push({ field: "ratePercent", message: "State the overhead rate." });
  }
  if (!overhead.basis) {
    out.push({ field: "basis", message: "State which costing subtotal overhead is charged on." });
  }
  return out;
}

/** One overhead field, validated by name. Absent stays absent; wrong is refused. */
function validateOverhead(patch = {}, existing = {}) {
  const out = { ...existing };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has("ratePercent")) {
    const v = patch.ratePercent;
    if (!present(v)) out.ratePercent = undefined;
    else {
      try {
        /* Up to 1000%, exactly as the rule this replaces allowed: a real
           overhead pool on a narrow basis can exceed 100% of it, and refusing
           that would be inventing a business rule. */
        out.ratePercent = percent(v, { field: "ratePercent", min: 0, max: 1000 }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
    }
  }

  if (has("basis")) {
    const v = str(patch.basis);
    if (!v) out.basis = undefined;
    else if (!BASIS_KEYS.includes(v)) {
      throw bad("That is not something overhead can be a percentage of.", {
        field: "basis", reason: "BASIS_UNKNOWN", allowed: BASIS_KEYS, value: v,
      });
    } else out.basis = v;
  }

  return out;
}

/* ══ THE CUSTOMS DUTY CONTRACT ═════════════════════════════════════════════ */

const isoCountry = (v) => str(v).toUpperCase();
const tariff = (v) => str(v).toUpperCase();

/** A duty rule's identity, for a person reading stored data or a provenance. */
function mintDutyKey(code, origin, taken = []) {
  const used = new Set(taken.map(String));
  const base = `${tariff(code)}-${isoCountry(origin)}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "rule";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw bad("That heading and origin have been used too many times to make a key from.", {
    field: "dutyRules", reason: "DUTY_RULE_KEY_EXHAUSTED",
  });
}

const dutyLabelFor = (table, key) =>
  (table || []).find((r) => String(r.key) === String(key))?.label
  || (table || []).find((r) => String(r.key) === String(key))?.customsTariffCode
  || key;

/**
 * A permanent rule key was dropped, or renamed out of the table.
 *
 * Same reasoning as the development charge catalogue: a frozen costing names
 * the key it was duty-rated under, and a key that disappears takes the meaning
 * of that record with it. Withdrawing a rule is `active: false`.
 */
const removedDutyKeys = (keys, table = []) => fail(
  "DUTY_RULE_KEY_REMOVED",
  keys.length === 1
    ? `The duty rule "${dutyLabelFor(table, keys[0])}" cannot be removed. Deactivate it instead — costings frozen under it still name it.`
    : `${keys.length} duty rules cannot be removed. Deactivate them instead — costings frozen under them still name them.`,
  {
    field: "dutyRules", reason: "DUTY_RULE_KEY_REMOVED",
    keys,
    rules: keys.map((k) => ({ key: k, label: dutyLabelFor(table, k) })),
    remedy: "DEACTIVATE",
  },
);

/**
 * WHAT A DUTY TABLE MUST NOT CONTAIN: TWO ANSWERS TO ONE QUESTION.
 *
 * ── WHY OVERLAP IS REFUSED AT THE WRITE ─────────────────────────────────────
 * Resolution matches on tariff code AND origin AND date. If two active rules
 * for one heading-and-origin overlap in time, a costing on a date inside both
 * has two rates and no way to choose — and choosing one silently would make
 * "which rate did this costing use" unanswerable for ever.
 *
 * Caught here rather than at the costing, because the person who can fix it is
 * here now, and every costing raised between the save and the discovery would
 * otherwise be blocked as ambiguous.
 *
 * INACTIVE rules are excluded from the check: a withdrawn rule matches nothing,
 * so a replacement may legitimately cover the same period.
 */
function assertNoDutyOverlap(rules = []) {
  const byPair = new Map();
  for (const r of rules) {
    if (r.active === false) continue;
    const pair = `${r.customsTariffCode}|${r.countryOfOrigin}`;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push(r);
  }
  for (const [pair, group] of byPair) {
    const sorted = [...group].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const [code, origin] = pair.split("|");
      /* An open-ended period swallows everything after it, so only the last
         may be open — reported separately, because the fix is different: one
         is two dates to reconcile, the other is one date left unclosed. */
      if (!cur.effectiveTo) {
        throw bad(
          `The duty rule for ${code} from ${origin} never ends, so the one after it starts inside it. `
          + "Close it on the date the next one starts.",
          {
            field: "dutyRules", reason: "DUTY_RULE_PERIOD_OPEN_ENDED",
            customsTariffCode: code, countryOfOrigin: origin,
          },
        );
      }
      if (cur.effectiveTo.getTime() > next.effectiveFrom.getTime()) {
        throw bad(
          `Two duty rules for ${code} from ${origin} apply at the same time. A costing could not say `
          + "which rate it used.",
          {
            field: "dutyRules", reason: "DUTY_RULE_PERIOD_OVERLAP",
            customsTariffCode: code, countryOfOrigin: origin,
          },
        );
      }
    }
  }
}

/**
 * What a duty table must state before it can be approved.
 *
 * An EMPTY table is a legitimate answer for a company that imports nothing —
 * so it is not a gap. What is a gap is a rule that could not be applied.
 */
function dutyGaps(rules) {
  const out = [];
  for (const r of (Array.isArray(rules) ? rules : [])) {
    const name = r.label || `${r.customsTariffCode || "?"} from ${r.countryOfOrigin || "?"}`;
    if (!str(r.customsTariffCode)) {
      out.push({ field: "dutyRules", key: r.key, message: `"${name}" has no customs tariff code.` });
    }
    if (!str(r.countryOfOrigin)) {
      out.push({ field: "dutyRules", key: r.key, message: `"${name}" has no country of origin.` });
    }
    if (!present(r.ratePercent)) {
      out.push({
        field: "dutyRules", key: r.key,
        message: `"${name}" has no duty rate. A rule with no rate is not a rule — and a rate of 0% `
          + "has to be stated as 0%, not left blank.",
      });
    }
    if (!r.effectiveFrom) {
      out.push({ field: "dutyRules", key: r.key, message: `"${name}" does not say when it takes effect.` });
    }
  }
  return out;
}

/**
 * The duty table, validated against what the DRAFT already holds.
 *
 * Whole rows, replaced together — the Board edits this as a table, and the
 * keys are the identity protocol.
 */
function validateDutyRules(incoming, existing) {
  if (!Array.isArray(incoming)) return Array.isArray(existing) ? existing : undefined;

  const stored = Array.isArray(existing) ? existing : [];
  const storedKeys = stored.map((r) => String(r.key));
  const seen = [];
  const out = [];

  for (const [index, raw] of incoming.entries()) {
    const code = tariff(raw?.customsTariffCode);
    const origin = isoCountry(raw?.countryOfOrigin);
    if (!code) {
      throw bad("Every duty rule needs a customs tariff code.", {
        field: "dutyRules", reason: "DUTY_RULE_TARIFF_REQUIRED", index,
      });
    }
    if (origin.length !== 2) {
      throw bad(
        `"${origin || "(blank)"}" is not an ISO-2 country code. Store records origin as two letters, and `
        + "a table keyed any other way would not match it.",
        { field: "dutyRules", reason: "DUTY_RULE_ORIGIN_INVALID", index, value: origin },
      );
    }

    const sent = str(raw?.key, 60);
    /* A key is claimed, never invented over: a client minting its own would
       give one rule two identities, and frozen costings pointing at the first
       would stop resolving. */
    if (sent && !storedKeys.includes(sent) && !seen.includes(sent)) {
      throw bad(`A duty rule names a key this policy does not have.`, {
        field: "dutyRules", reason: "DUTY_RULE_KEY_UNKNOWN", index, key: sent,
      });
    }
    const key = sent || mintDutyKey(code, origin, [...storedKeys, ...seen]);
    if (seen.includes(key)) {
      throw bad(`Two duty rules share the key "${key}".`, {
        field: "dutyRules", reason: "DUTY_RULE_KEY_DUPLICATE", index, key,
      });
    }
    seen.push(key);

    let ratePercent;
    try {
      /* Zero allowed and meaningful. Capped at 100: a duty above the value of
         the goods is not a rate this contract can express truthfully. */
      ratePercent = percent(raw?.ratePercent, {
        field: "ratePercent", min: 0, max: 100,
      }).toFixed();
    } catch (err) {
      if (err instanceof DecimalError) throw bad(err.message, { ...err.details, index });
      throw err;
    }

    const from = asDate(raw?.effectiveFrom, "effectiveFrom");
    if (!from) {
      throw bad(`The duty rule for ${code} from ${origin} needs the date it takes effect from.`, {
        field: "dutyRules", reason: "DUTY_RULE_PERIOD_START_REQUIRED", index,
      });
    }
    const to = asDate(raw?.effectiveTo, "effectiveTo");
    if (to && to.getTime() <= from.getTime()) {
      throw bad(`The duty rule for ${code} from ${origin} ends on or before the day it starts.`, {
        field: "dutyRules", reason: "DUTY_RULE_WINDOW_INVALID", index,
      });
    }

    out.push({
      key,
      customsTariffCode: code,
      countryOfOrigin: origin,
      ratePercent,
      effectiveFrom: from,
      ...(to ? { effectiveTo: to } : {}),
      active: raw?.active !== false,
      label: str(raw?.label, 200),
      note: str(raw?.note, 1000),
    });
  }

  const gone = storedKeys.filter((k) => !seen.includes(k));
  if (gone.length) throw removedDutyKeys(gone, stored);

  assertNoDutyOverlap(out);
  return out;
}

/** Nothing in force may vanish from the version that supersedes it. */
function supersedeDutyRules(next, previous) {
  const held = (Array.isArray(next) ? next : []).map((r) => String(r.key));
  const before = Array.isArray(previous) ? previous : [];
  const gone = before.map((r) => String(r.key)).filter((k) => !held.includes(k));
  if (gone.length) throw removedDutyKeys(gone, before);
}

/* ══ THE MARGIN CONTRACT ═══════════════════════════════════════════════════ */

/**
 * What a margin policy must state before it can be approved.
 *
 * ── ALL THREE, BECAUSE THE ENGINE REQUIRES ALL THREE ────────────────────────
 * `engine.js` reads every band figure as required and refuses `undefined`. A
 * partial band is not a lenient policy; it is a policy no costing can be
 * calculated under. So none of the three is optional, and the ordering is part
 * of completeness rather than a warning.
 *
 * The threshold and the tax rate are NOT gaps. Neither is needed to price
 * anything: the threshold is a recorded intent nothing enforces, and the tax
 * rate changes only the after-tax commentary.
 */
function marginGaps(margin = {}) {
  const out = [];

  /* ── V2 IS THE ONLY CONTRACT A NEW VERSION MAY BE APPROVED UNDER ──────
     One required figure, and `0` counts as stated. A version carrying no
     markup is not a lenient policy; it is a policy no costing can be priced
     under, and `assertApproved` refuses the costing naming the Board rather
     than letting the engine complain about a field. */
  if (contractOf(margin) === "MARKUP_FLOOR_V2") {
    if (!present(margin.floorMarkupPercent)) {
      out.push({
        field: "floorMarkupPercent",
        message: "State the management markup — the percentage added to a product's true cost to give "
          + "its floor selling price. Zero is a decision the Board can take; blank is not.",
      });
    }
    return out;
  }

  /* ── AND A BAND CAN NO LONGER BE APPROVED AT ALL ──────────────────────
     Versions already approved under V1 keep working and keep being read.
     What is refused is approving a NEW one: two pricing contracts in force
     for one company would mean two different floors for one costing. */
  out.push({
    field: "floorMarkupPercent",
    message: "The three-band margin model is retired. This company's pricing floor is one management "
      + "markup percentage — state it, and the band on this draft becomes a historical record.",
  });
  return out;
}

/** Which pricing contract a payload speaks. Absent reads as the retired band. */
function contractOf(margin = {}) {
  if (margin.pricingContract) return margin.pricingContract;
  return present(margin.floorMarkupPercent) ? "MARKUP_FLOOR_V2" : "MARGIN_BAND_V1";
}

/** The retired band's gaps, kept for reading historical drafts only. */
function legacyMarginGaps(margin = {}) {
  const out = [];
  const need = [
    ["minimumMarginPercent", "State the commercial floor — the margin below which the company would rather not sell."],
    ["targetMarginPercent", "State the target — the normal acceptable return."],
    ["preferredMarginPercent", "State the preferred margin — the recommended opening position."],
  ];
  for (const [field, message] of need) {
    if (!present(margin[field])) out.push({ field, message });
  }
  if (out.length) return out;

  /* ── THE ORDERING IS COMPLETENESS, NOT A WARNING ──────────────────────
     A band that runs the wrong way is refused by the engine on every costing
     the company raises. Approving one would put a rule into force that
     nothing can apply, which is the definition of an incomplete decision. */
  const min = new Decimal(margin.minimumMarginPercent);
  const target = new Decimal(margin.targetMarginPercent);
  const preferred = new Decimal(margin.preferredMarginPercent);
  if (min.isGreaterThan(target) || target.isGreaterThan(preferred)) {
    out.push({
      field: "targetMarginPercent",
      message: "Margins have to run minimum ≤ target ≤ preferred. A floor above the target is not a "
        + "stricter policy — it is one no costing can be calculated under.",
    });
  }
  return out;
}

/**
 * One margin field, validated by name.
 *
 * ── ZERO IS A DECISION; ABSENT IS NOT ───────────────────────────────────────
 * `0` is accepted throughout: a company may genuinely approve a nil floor, and
 * a policy that refused it would force it to state a number it does not mean.
 * What `0` must never be is a stand-in for silence — which is why nothing here
 * defaults, and why the gaps above insist on all three.
 *
 * 100% is excluded, not merely capped: at a margin of 1 the price
 * `cost / (1 - margin)` is a division by zero, so it is not a high margin, it
 * is not a price at all.
 */
function validateMargin(patch = {}, existing = {}) {
  const out = { ...existing };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const take = (field, opts = {}) => {
    if (!has(field)) return;
    const v = patch[field];
    if (!present(v)) { out[field] = undefined; return; }
    try {
      out[field] = percent(v, { field, min: 0, max: 100, maxExclusive: true, ...opts }).toFixed();
    } catch (err) {
      if (err instanceof DecimalError) throw bad(err.message, err.details);
      throw err;
    }
  };

  /* ── THE ONE ACTIVE FIGURE ────────────────────────────────────────────
     No upper bound of 100: a markup of 150% is an ordinary commercial
     decision, and the division-by-zero that made 100 impossible for a margin
     does not exist here — `cost × (1 + m/100)` is defined for every m ≥ 0.
     Negative is refused: a floor below cost is not a floor. */
  if (has("floorMarkupPercent")) {
    const v = patch.floorMarkupPercent;
    if (!present(v)) {
      out.floorMarkupPercent = undefined;
    } else {
      try {
        out.floorMarkupPercent = percent(v, { field: "floorMarkupPercent", min: 0, max: 100000 }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
      out.pricingContract = "MARKUP_FLOOR_V2";
    }
  }
  if (has("pricingContract") && present(patch.pricingContract)) {
    if (patch.pricingContract !== "MARKUP_FLOOR_V2") {
      throw bad(
        "The three-band margin contract is retired. A new pricing policy states one management markup.",
        { field: "pricingContract", reason: "PRICING_CONTRACT_RETIRED", value: patch.pricingContract },
      );
    }
    out.pricingContract = "MARKUP_FLOOR_V2";
  }

  /* ── AND THE FOUR RETIRED INPUTS, REFUSED BY NAME ─────────────────────
     Refused rather than ignored. A body still sending a band would otherwise
     be answered 200 while nothing it sent was stored, and whoever sent it
     would believe the company's floor had moved. The message says where the
     old values still live, because they are not deleted — every version that
     froze them still shows them. */
  for (const retired of [
    "minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent",
    "approvalThresholdMarginPercent",
  ]) {
    if (has(retired) && present(patch[retired])) {
      throw bad(
        "The three-band margin model is retired. A pricing policy now states one management markup "
        + "percentage, and the floor price is the product's true cost plus that markup.",
        {
          field: retired, reason: "MARGIN_BAND_RETIRED",
          use: "floorMarkupPercent",
          note: "Versions already approved under the band keep it, unchanged, as a historical record.",
        },
      );
    }
  }
  if (has("estimatedIncomeTaxRatePercent") && present(patch.estimatedIncomeTaxRatePercent)) {
    throw bad(
      "An estimated income-tax rate is a management-reporting assumption about profit after a price "
      + "is agreed. It is not part of a product's cost and not part of its floor price.",
      {
        field: "estimatedIncomeTaxRatePercent", reason: "NOT_A_PRICING_INPUT",
        note: "Preserved on versions that already froze it.",
      },
    );
  }

  /* ── THE BAND ORDERING, NOW UNREACHABLE FROM A WRITE ──────────────────
     Kept because a draft seeded from a historical version still carries the
     three values, and a nonsensical band must not survive a round trip even
     though nothing new can set one. Reaching it requires values already on
     the record, since a patch carrying any of them is refused above. */
  const all = ["minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent"];
  if (all.every((f) => present(out[f]))) {
    const [min, target, preferred] = all.map((f) => new Decimal(out[f]));
    if (min.isGreaterThan(target) || target.isGreaterThan(preferred)) {
      throw bad(
        "Margins have to run minimum ≤ target ≤ preferred.",
        {
          field: "targetMarginPercent", reason: "MARGIN_BAND_OUT_OF_ORDER",
          minimum: out.minimumMarginPercent,
          target: out.targetMarginPercent,
          preferred: out.preferredMarginPercent,
        },
      );
    }
  }

  return out;
}

/* ══ THE CONTINGENCY CONTRACT ══════════════════════════════════════════════ */

/**
 * WHICH SUBTOTALS A CONTINGENCY LINE CAN ACTUALLY BE CHARGED ON.
 *
 * ── A LATENT BREAKAGE THE OLD WRITER LET THROUGH ────────────────────────────
 * The engine synthesises contingency as a `MISC` line, and four of the eleven
 * bases INCLUDE `MISC` — `DIRECT`, `DIRECT_PLUS_FIXED`, `SUBTOTAL_BEFORE_OVERHEAD`
 * and `SUBTOTAL_BEFORE_FINANCING`. A percentage of a total that contains itself
 * is a simultaneous equation `orderPercentLines` deliberately refuses, so any
 * company that stored one of those four had EVERY costing it raised refused
 * with `CIRCULAR_PERCENT_BASIS` — not the contingency line, the whole costing.
 *
 * The retired costing-policy writer accepted all eleven, so this was
 * discoverable only by raising a costing and having it fail. It is refused
 * here, at the one moment somebody can still choose differently.
 *
 * Derived from the engine's own `BASES` rather than listed, so a basis added
 * to the engine is classified by the same rule that made these four unusable.
 */
const CONTINGENCY_BASES = Object.freeze(
  BASIS_KEYS.filter((k) => !(ENGINE_BASES[k] || []).includes("MISC")),
);

/**
 * What a contingency decision must state before it can be approved.
 *
 * ── THE MODE IS THE DECISION ────────────────────────────────────────────────
 * Not the rate. A Board that has not said whether the company adds a standard
 * contingency at all has not made this decision, and no rate supplies it.
 */
function contingencyGaps(contingency = {}) {
  const out = [];
  const mode = str(contingency.mode);
  if (!mode) {
    out.push({
      field: "mode",
      message: "State whether the company adds a standard contingency, or has decided it does not.",
    });
    return out;
  }
  if (mode === "NONE") {
    /* ── A DECISION NOT TO IS STILL A DECISION, AND NEEDS ITS REASON ───
       The rationale is compulsory here and nowhere else in this contract: a
       nil contingency looks identical to an oversight a year later, and the
       one thing that distinguishes them is somebody having written down why.
       Checked as a GAP rather than at the write, because a draft is where a
       decision is worked out. */
    if (!str(contingency.rationale)) {
      out.push({
        field: "rationale",
        message: "A decision not to apply a standard contingency needs its reason recorded. "
          + "Without one it is indistinguishable from nobody having considered it.",
      });
    }
    return out;
  }
  if (!present(contingency.ratePercent)) {
    out.push({ field: "ratePercent", message: "State the contingency rate." });
  }
  if (!contingency.basis) {
    out.push({ field: "basis", message: "State which costing subtotal contingency is charged on." });
  }
  return out;
}

/**
 * One contingency decision, validated by name.
 *
 * ── WHY SWITCHING TO `NONE` CLEARS THE RATE ─────────────────────────────────
 * A stored rate under a `NONE` decision is a number the company is not
 * applying, sitting on the record where a later reader would take it for the
 * one in force. The decision is what is approved; a rate it does not use is
 * not part of it.
 */
function validateContingency(patch = {}, existing = {}) {
  const out = { ...existing };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has("mode")) {
    const v = str(patch.mode).toUpperCase();
    if (!v) out.mode = undefined;
    else if (!CONTINGENCY_MODES.includes(v)) {
      throw bad("That is not a contingency decision this system knows.", {
        field: "mode", reason: "CONTINGENCY_MODE_UNKNOWN",
        allowed: [...CONTINGENCY_MODES], value: v,
      });
    } else out.mode = v;
  }

  if (has("ratePercent")) {
    const v = patch.ratePercent;
    if (!present(v)) out.ratePercent = undefined;
    else {
      try {
        /* ── ZERO IS ALLOWED, AND IS NOT THE SAME AS `NONE` ────────────
           "We add a contingency, currently nil" keeps a line in every
           build-up that a later Board can raise. It is a different statement
           from "we do not add one", and both are available deliberately.

           Capped at 100: a contingency is a margin of error on a cost, and a
           rate above the thing it is a percentage of is a different kind of
           decision that should not arrive through this field by accident. */
        out.ratePercent = percent(v, { field: "ratePercent", min: 0, max: 100 }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
    }
  }

  if (has("basis")) {
    const v = str(patch.basis);
    if (!v) out.basis = undefined;
    else if (!BASIS_KEYS.includes(v)) {
      throw bad("That is not something contingency can be a percentage of.", {
        field: "basis", reason: "BASIS_UNKNOWN", allowed: [...CONTINGENCY_BASES], value: v,
      });
    } else if (!CONTINGENCY_BASES.includes(v)) {
      /* Refused by name, and told WHY — this is the one the old writer let
         through and the costing discovered weeks later. */
      throw bad(
        `Contingency cannot be a percentage of ${v}, because that subtotal already includes the `
        + "contingency line itself. A costing charged this way could not be calculated at all.",
        {
          field: "basis", reason: "CONTINGENCY_BASIS_CIRCULAR",
          value: v, allowed: [...CONTINGENCY_BASES],
        },
      );
    } else out.basis = v;
  }

  /* ── A DECISION NOT TO APPLY ONE CARRIES NO RATE ──────────────────────
     Cleared here rather than refused, because the caller is not doing
     anything wrong: they are changing their mind about the mode, and the rate
     that was being prepared under the old one simply stops being part of the
     decision. */
  if (out.mode === "NONE") {
    out.ratePercent = undefined;
    out.basis = undefined;
  }

  return out;
}

/* ══ THE LABOUR CONTRACT ═══════════════════════════════════════════════════ */

/**
 * What a labour methodology must state before it can be approved.
 *
 * ── THE ONE RULE THAT IS NOT "IS IT FILLED IN" ──────────────────────────────
 * The productive basis is EXACTLY ONE of two fields. Neither is a company that
 * has not said how much of a paid month is productive; both is a company that
 * has said two different numbers — 9,000 minutes and 80% of 12,480 is 9,984 —
 * and silently preferring either buries that disagreement inside every labour
 * rate the company quotes.
 *
 * `labourCost.productiveBasis()` has always refused both-at-once at
 * calculation time. This is the same rule at approval time, so a Board never
 * approves a methodology the engine will then refuse.
 */
function labourGaps(labour = {}) {
  const out = [];
  const hasMinutes = present(labour.productiveMinutesPerMonth);
  const hasEfficiency = present(labour.labourEfficiencyPercent);

  if (hasMinutes && hasEfficiency) {
    out.push({
      field: "productiveMinutesPerMonth",
      message: "State productive minutes per month OR a labour efficiency, not both — "
        + "they are two answers to one question.",
    });
  } else if (!hasMinutes && !hasEfficiency) {
    out.push({
      field: "productiveMinutesPerMonth",
      message: "State how much of a paid month is productive — either the minutes, or an efficiency.",
    });
  }

  /* Zero is a decision a company may genuinely make; absent is not zero. */
  if (!present(labour.employerBurdenPercent)) {
    out.push({
      field: "employerBurdenPercent",
      message: "State the employer burden. Without it an operator costs only their take-home pay.",
    });
  }
  if (!labour.machineBurdenTreatment) {
    out.push({ field: "machineBurdenTreatment", message: "State where machine cost is accounted for." });
  }
  /* ── AN EXCLUSION HAS TO SAY WHY ───────────────────────────────────────
     The other two treatments name somewhere the cost IS carried. This one
     says it is carried nowhere, which is exactly the decision somebody will
     be asked to justify later. */
  if (labour.machineBurdenTreatment === "NOT_COSTED" && !str(labour.machineExclusionReason)) {
    out.push({
      field: "machineExclusionReason",
      message: "Say why machine cost is not costed at all.",
    });
  }
  return out;
}

/** One labour field, validated by name. Absent stays absent; wrong is refused. */
function validateLabour(patch = {}, existing = {}) {
  const out = { ...existing };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has("productiveMinutesPerMonth")) {
    const v = patch.productiveMinutesPerMonth;
    if (!present(v)) out.productiveMinutesPerMonth = undefined;
    else if (!Number.isFinite(Number(v)) || Number(v) <= 0) {
      throw bad("Productive minutes per month must be a positive number.", {
        field: "productiveMinutesPerMonth", reason: "PRODUCTIVE_MINUTES_INVALID", value: v,
      });
    } else out.productiveMinutesPerMonth = Number(v);
  }

  if (has("labourEfficiencyPercent")) {
    const v = patch.labourEfficiencyPercent;
    if (!present(v)) out.labourEfficiencyPercent = undefined;
    else {
      try {
        /* Above 100% is not an efficiency; it is a productive-minutes figure
           entered in the wrong box. */
        out.labourEfficiencyPercent = percent(v, {
          field: "labourEfficiencyPercent", min: 0, max: 100,
        }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
    }
  }

  /* ── REFUSED AT THE WRITE, NOT ONLY AT APPROVAL ────────────────────────
     A draft holding both is a draft somebody has to be told about now rather
     than when they press approve — and it is the same refusal the legacy
     endpoint made, so nothing about the rule changed with its owner. */
  if (present(out.productiveMinutesPerMonth) && present(out.labourEfficiencyPercent)) {
    throw bad(
      "State productive minutes per month OR a labour efficiency, not both — they are two answers to one question.",
      { field: "productiveMinutesPerMonth", reason: "PRODUCTIVE_BASIS_AMBIGUOUS" },
    );
  }

  if (has("employerBurdenPercent")) {
    const v = patch.employerBurdenPercent;
    if (!present(v)) out.employerBurdenPercent = undefined;
    else {
      try {
        /* Above 100% is real — a burden can exceed take-home pay in some
           structures — so only the lower bound is a business rule. The upper
           bound is the one the retired endpoint used. */
        out.employerBurdenPercent = percent(v, {
          field: "employerBurdenPercent", min: 0, max: 1000,
        }).toFixed();
      } catch (err) {
        if (err instanceof DecimalError) throw bad(err.message, err.details);
        throw err;
      }
    }
  }

  if (has("machineBurdenTreatment")) {
    const v = str(patch.machineBurdenTreatment);
    if (!v) out.machineBurdenTreatment = undefined;
    else if (!MACHINE_BURDEN_TREATMENTS.includes(v)) {
      throw bad("Machine cost sits inside the operation rate, in overhead, or is not costed.", {
        field: "machineBurdenTreatment", reason: "VALUE_NOT_ALLOWED",
        allowed: [...MACHINE_BURDEN_TREATMENTS], value: v,
      });
    } else out.machineBurdenTreatment = v;
  }

  if (has("machineExclusionReason")) {
    out.machineExclusionReason = str(patch.machineExclusionReason).slice(0, 1000);
  }

  return out;
}

/* ══ THE INPUT GST CONTRACT ════════════════════════════════════════════════ */

/**
 * What an input GST policy must state before it can be approved.
 *
 * One question, and the shortest contract of the four — which is exactly why
 * it is still its own contract rather than folded in. "Is the payload
 * non-empty" would pass a `gst` sub-document carrying somebody else's field.
 */
function gstGaps(gst = {}) {
  if (!gst.inputGstTreatment) {
    return [{
      field: "inputGstTreatment",
      message: "State whether eligible input GST is reclaimed or included in product cost.",
    }];
  }
  return [];
}

/** The one GST field, validated by name. Absent stays absent; wrong is refused. */
function validateGst(patch = {}, existing = {}) {
  const out = { ...existing };
  if (!Object.prototype.hasOwnProperty.call(patch, "inputGstTreatment")) return out;

  const v = str(patch.inputGstTreatment);
  if (!v) {
    out.inputGstTreatment = undefined;
    return out;
  }
  if (!GST_TREATMENTS.includes(v)) {
    /* Two answers, and `NONE` is deliberately not one of them: it is the
       absence of an opinion rather than a third opinion, and a quotation that
       genuinely carries no GST says so itself through `NON_TAXABLE`. */
    throw bad("Eligible input GST is either reclaimed by this company or it is part of product cost.", {
      field: "inputGstTreatment", reason: "VALUE_NOT_ALLOWED",
      allowed: [...GST_TREATMENTS], value: v,
    });
  }
  out.inputGstTreatment = v;
  return out;
}

/* ══ THE DEVELOPMENT CHARGE CATALOGUE ══════════════════════════════════════ */

/* A date, or null. The module already has `asDate(value, field)`, which THROWS
   on a bad value with a field name; a rate period wants the quiet form so the
   refusal below can say which period and why. */
const rateDate = (v) => {
  if (!present(v)) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * A readable, permanent key minted from a label.
 *
 * Suffixed rather than overwritten when the slug is taken — INCLUDING by a
 * charge deactivated years ago, because its key is still pointed at by
 * requirements and frozen versions.
 */
function mintChargeKey(label, taken = []) {
  const used = new Set(taken.map(String));
  const base = String(label).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "charge";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw bad("That name has been used too many times to make a key from.", {
    field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_KEY_EXHAUSTED",
  });
}

const labelFor = (table, key) =>
  (table || []).find((c) => String(c.key) === String(key))?.label || key;

/**
 * A permanent key was dropped, or renamed out of the table.
 *
 * ── WHY THIS IS A REFUSAL AND NOT A DELETE ──────────────────────────────────
 * Live Merchandising requirements point at these keys, and versions frozen
 * months ago name them in their provenance. A key that disappears takes the
 * meaning of both with it: the requirement can no longer be priced and the old
 * costing can no longer be explained. Withdrawing a charge is what
 * `active: false` is for — it stops being offered and stays readable.
 *
 * The same refusal, the same code and the same remedy the retired costing
 * policy raised. Moving the catalogue must not relax the one rule that makes
 * its keys worth anything.
 */
const removedKeys = (keys, table = []) => fail(
  "DEVELOPMENT_CHARGE_KEY_REMOVED",
  keys.length === 1
    ? `The development charge "${labelFor(table, keys[0])}" cannot be removed. Deactivate it instead — requirements and frozen costings still point at it.`
    : `${keys.length} development charges cannot be removed. Deactivate them instead — requirements and frozen costings still point at them.`,
  {
    field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_KEY_REMOVED",
    keys,
    charges: keys.map((k) => ({ key: k, label: labelFor(table, k) })),
    remedy: "DEACTIVATE",
  },
);

/**
 * One charge's rate periods, validated as a WHOLE.
 *
 * ── WHY OVERLAP IS REFUSED RATHER THAN RESOLVED ─────────────────────────────
 * `developmentCharges.selectPeriod` returns a refusal when two periods match a
 * date, because picking one would make "which rate did this costing use"
 * unanswerable. Catching it at the WRITE is better than catching it at the
 * costing: the person who can fix it is here, now, and every costing between
 * the save and the discovery would otherwise be blocked.
 *
 * Half-open `[from, to)`, so a period ending on the 1st and one starting on
 * the 1st do not overlap. An open-ended period swallows everything after it,
 * so only the last may be open.
 */
function validateRatePeriods(rates, { chargeLabel }) {
  const out = [];
  for (const [i, raw] of (rates || []).entries()) {
    const from = rateDate(raw?.effectiveFrom);
    if (!from) {
      throw bad(`A rate for "${chargeLabel}" needs the date it takes effect from.`, {
        field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_PERIOD_START_REQUIRED", index: i,
      });
    }
    const to = rateDate(raw?.effectiveTo);
    if (to && to.getTime() <= from.getTime()) {
      throw bad(`A rate for "${chargeLabel}" ends on or before the day it starts.`, {
        field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_WINDOW_INVALID", index: i,
      });
    }
    const amount = Number(raw?.amountMinor);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw bad(
        `A rate for "${chargeLabel}" has to be a whole number of paise, and not negative — a charge is not a refund.`,
        { field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_AMOUNT_INVALID", index: i },
      );
    }
    /* ── ONE CURRENCY, BECAUSE THERE IS NO SECOND ONE TO CONVERT FROM ──
       Nothing in this system holds an exchange rate. A charge published in
       another currency could only reach an INR costing by being guessed at,
       and a guess inside a total cannot be told from a fact. */
    const currency = str(raw?.currency).toUpperCase() || "INR";
    if (currency !== "INR") {
      throw bad(
        `A rate for "${chargeLabel}" is in ${currency}. Company charges are published in INR — there is `
        + "no exchange rate source in this system, so anything else could only be converted by guessing.",
        {
          field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_CURRENCY_UNSUPPORTED",
          index: i, value: currency, expected: "INR",
        },
      );
    }
    out.push({
      amountMinor: amount,
      currency,
      effectiveFrom: from,
      ...(to ? { effectiveTo: to } : {}),
    });
  }

  out.sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  for (let i = 0; i < out.length - 1; i += 1) {
    const cur = out[i];
    const next = out[i + 1];
    /* ── AN OPEN-ENDED PERIOD SWALLOWS EVERYTHING AFTER IT ────────────
       So only the LAST may be open. Reported as its own refusal rather than
       as an overlap, because the fix is different: an overlap is two dates
       somebody has to reconcile, and this is one date somebody forgot to
       close. */
    if (!cur.effectiveTo) {
      throw bad(
        `A rate for "${chargeLabel}" never ends, so the one after it starts inside it. `
        + "Close it on the date the next one starts.",
        { field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_PERIOD_OPEN_ENDED", index: i },
      );
    }
    if (cur.effectiveTo.getTime() > next.effectiveFrom.getTime()) {
      throw bad(
        `Two rates for "${chargeLabel}" apply at the same time. A costing could not say which one it used.`,
        { field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_PERIOD_OVERLAP", index: i },
      );
    }
  }
  return out;
}

/**
 * What a charge catalogue must state before it can be approved.
 *
 * An empty catalogue is a legitimate answer for a company that does no
 * development work itself — so it is NOT a gap. What is a gap is a charge that
 * cannot be priced: no rate at all, or a per-unit charge with no unit to count.
 */
function developmentChargeGaps(charges) {
  const out = [];
  /* The generic dispatch hands `{}` when the field is absent — this key's
     payload is a LIST, not the object the other four use, so "absent" arrives
     as a shape rather than as undefined. A catalogue nobody has written is the
     empty one, which is not a gap. */
  for (const c of (Array.isArray(charges) ? charges : [])) {
    const label = c.label || c.key || "a charge";
    if (!(c.rates || []).length) {
      out.push({ field: "developmentCharges", key: c.key, message: `"${label}" has no rate.` });
    }
    if (c.calculation === "PER_REQUIREMENT_UNIT" && !str(c.unit)) {
      out.push({
        field: "developmentCharges", key: c.key,
        message: `"${label}" is charged per unit, so it has to say what one unit is — a screen, `
          + "a plate, a pattern.",
      });
    }
  }
  return out;
}

/**
 * The catalogue, validated against what the DRAFT already holds.
 *
 * Whole rows, replaced together: the Board edits this as a list, and a
 * per-entry patch protocol would need an identity scheme of its own on top of
 * the one the keys already provide.
 */
function validateDevelopmentCharges(incoming, existing) {
  /* ── THIS PAYLOAD IS A LIST, AND THE DISPATCH IS SHAPE-BLIND ──────────
     `createDraft` and `updateDraft` default a missing payload to `{}` because
     the other four keys are objects. For this one that default IS the "not
     sent" signal: anything that is not an array leaves the stored catalogue
     exactly as it was, so a draft edited for its rationale alone does not
     quietly lose its charges. */
  if (!Array.isArray(incoming)) return Array.isArray(existing) ? existing : undefined;

  const stored = Array.isArray(existing) ? existing : [];
  const storedKeys = stored.map((c) => String(c.key));
  const seen = [];
  const out = [];

  for (const [index, raw] of incoming.entries()) {
    const label = str(raw?.label, 200);
    if (!label) {
      throw bad("Every development charge needs a name.", {
        field: "developmentCharges", reason: "LABEL_REQUIRED", index,
      });
    }
    const sent = str(raw?.key, 60);
    /* ── A KEY IS CLAIMED, NEVER INVENTED OVER ────────────────────────
       A row arriving with a key must be one this draft already has: a client
       inventing a key would create a second identity for the same charge, and
       requirements pointing at the first would silently stop resolving. */
    if (sent && !storedKeys.includes(sent) && !seen.includes(sent)) {
      throw bad(`"${label}" names a development charge key this policy does not have.`, {
        field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_KEY_UNKNOWN",
        index, key: sent,
      });
    }
    const key = sent || mintChargeKey(label, [...storedKeys, ...seen]);
    if (seen.includes(key)) {
      throw bad(`Two development charges share the key "${key}".`, {
        field: "developmentCharges", reason: "DEVELOPMENT_CHARGE_KEY_DUPLICATE", index, key,
      });
    }
    seen.push(key);

    const calculation = str(raw?.calculation) || "FLAT_PER_RUN";
    if (!DEVELOPMENT_CALCULATIONS.includes(calculation)) {
      throw bad(`"${label}" has a calculation this system does not know.`, {
        field: "developmentCharges", reason: "CALCULATION_UNKNOWN",
        index, allowed: [...DEVELOPMENT_CALCULATIONS],
      });
    }

    out.push({
      key,
      label,
      description: str(raw?.description, 1000),
      calculation,
      /* A unit on a flat charge would name a quantity nobody enters. */
      ...(calculation === "PER_REQUIREMENT_UNIT" && str(raw?.unit, 60)
        ? { unit: str(raw?.unit, 60) } : {}),
      active: raw?.active !== false,
      rates: validateRatePeriods(raw?.rates, { chargeLabel: label }),
    });
  }

  /* ── AND NOTHING MAY VANISH ───────────────────────────────────────────
     Checked after the rows are built, so the refusal can name the charges by
     the labels they were stored under. */
  const gone = storedKeys.filter((k) => !seen.includes(k));
  if (gone.length) throw removedKeys(gone, stored);

  return out;
}

/**
 * WHAT A NEW CATALOGUE MAY NOT TAKE AWAY FROM THE ONE IT REPLACES.
 *
 * Every key in force has to still be in the new version — active or not.
 * Withdrawing a charge is `active: false`; deleting one takes the meaning of
 * every requirement and every frozen costing that names it.
 */
function supersedeDevelopmentCharges(next, previous) {
  const held = (Array.isArray(next) ? next : []).map((c) => String(c.key));
  const before = Array.isArray(previous) ? previous : [];
  const gone = before.map((c) => String(c.key)).filter((k) => !held.includes(k));
  if (gone.length) throw removedKeys(gone, before);
}

/* ══ ONE LIFECYCLE, EACH POLICY'S OWN CONTRACT ═════════════════════════════ */

/**
 * The per-key table the generic acts dispatch through.
 *
 * ── WHY A TABLE AND NOT A SHARED FORM ───────────────────────────────────────
 * The draft, the approval, the effective date, the supersession rule and the
 * company isolation are genuinely the same for every company policy, and they
 * are written once below. What a policy MEANS is not the same, and pretending
 * it is would cost each policy its validation: financing's four questions and
 * overhead's two would collapse into "is the payload non-empty", which
 * approves a rate with no basis and a duration with no day count.
 *
 * So the lifecycle is shared and the contract is looked up.
 */
const CONTRACT = Object.freeze({
  FINANCING: { field: PAYLOAD_FIELD.FINANCING, validate: validateFinancing, gaps: financingGaps },
  OVERHEAD: { field: PAYLOAD_FIELD.OVERHEAD, validate: validateOverhead, gaps: overheadGaps },
  LABOUR_METHODOLOGY: {
    field: PAYLOAD_FIELD.LABOUR_METHODOLOGY, validate: validateLabour, gaps: labourGaps,
  },
  GST_TAX_POLICY: { field: PAYLOAD_FIELD.GST_TAX_POLICY, validate: validateGst, gaps: gstGaps },
  DUTY_POLICY: {
    field: PAYLOAD_FIELD.DUTY_POLICY,
    validate: validateDutyRules,
    gaps: dutyGaps,
    /* Like the development catalogue: a rule key is a permanent identity, so
       it constrains what may supersede the version that published it. */
    supersede: supersedeDutyRules,
  },
  MARGIN_POLICY: {
    field: PAYLOAD_FIELD.MARGIN_POLICY,
    validate: validateMargin,
    gaps: marginGaps,
  },
  CONTINGENCY_POLICY: {
    field: PAYLOAD_FIELD.CONTINGENCY_POLICY,
    validate: validateContingency,
    /* The only `gaps` that reads the version's own `rationale` as well as its
       payload: a decision NOT to apply a contingency needs its reason, and the
       reason lives on the version. */
    gaps: contingencyGaps,
    gapsNeedRationale: true,
  },
  DEVELOPMENT_CHARGE_POLICY: {
    field: PAYLOAD_FIELD.DEVELOPMENT_CHARGE_POLICY,
    validate: validateDevelopmentCharges,
    gaps: developmentChargeGaps,
    /* The only key with a permanent identity inside its payload, so the only
       one that constrains what may SUPERSEDE it. */
    supersede: supersedeDevelopmentCharges,
  },
});

const contractFor = (policyKey) => {
  const c = CONTRACT[policyKey];
  if (!c) throw bad("That is not a Board policy this company keeps.", { field: "policyKey", value: policyKey });
  return c;
};

/** What is still open on one version, whichever policy it is. */
/**
 * What is still open on one version.
 *
 * ── ONE CONTRACT NEEDS MORE THAN ITS PAYLOAD ────────────────────────────────
 * `rationale` lives on the VERSION, not inside any policy's sub-document,
 * because every policy has one and none of them validates it. Contingency is
 * the exception: a decision NOT to apply one is indistinguishable from an
 * oversight unless somebody wrote down why, so for that key the rationale is
 * part of completeness. It is handed in rather than read from a second place,
 * so there is still exactly one gap function per key.
 */
const gapsFor = (doc) => {
  const contract = doc?.policyKey ? CONTRACT[doc.policyKey] : null;
  if (!contract) return [];
  const payload = doc[contract.field] || {};
  return contract.gaps(
    contract.gapsNeedRationale ? { ...payload, rationale: doc.rationale } : payload,
  );
};

/* ══ THE ACTS ══════════════════════════════════════════════════════════════ */

/**
 * A new draft. Empty is allowed — a draft is where a decision is worked out.
 *
 * ── SEEDING, AND WHY IT CANNOT BE DONE BY THE CLIENT ────────────────────────
 * A draft may START from something that already exists: the retired values on
 * the costing policy, or the version currently in force. That is a convenience
 * for the two policies with real content to retype, and for the charge
 * catalogue it is more than a convenience — a charge's KEY is what stored
 * requirements and frozen costings point at, and `validateDevelopmentCharges`
 * refuses a key the draft does not already have, precisely so a client cannot
 * invent a second identity for the same charge. A client re-posting the legacy
 * keys would therefore be refused every time, and a client posting them
 * without keys would mint new ones and silently orphan every requirement.
 *
 * So the seed is applied HERE, validated against itself: every rule still runs
 * — a legacy table with overlapping rate periods is refused rather than
 * quietly carried in — but its own keys are claimable, which is the whole
 * point of copying it.
 *
 * `seededFrom` records that this content was copied rather than authored.
 * Copying is not approving: the draft still has to be approved by a named
 * person with an effective date, exactly like one typed from nothing.
 */
async function createDraft(ctx, {
  policyKey = "FINANCING", rationale = "", effectiveFrom = null,
  seed = null, seededFrom = null, ...payload
} = {}) {
  const contract = contractFor(policyKey);
  const seeded = seed !== null && seed !== undefined;
  const doc = await BoardPolicy.create({
    companyId: ctx.companyId,
    policyKey,
    status: "DRAFT",
    /* Only this key's own sub-document is written. A body carrying another
       policy's payload writes nothing of it — the field is not read. */
    [contract.field]: seeded
      ? contract.validate(seed, seed)
      : contract.validate(payload[contract.field] || {}, {}),
    ...(seeded && seededFrom ? { seededFrom } : {}),
    rationale: str(rationale).slice(0, 4000),
    effectiveFrom: asDate(effectiveFrom, "effectiveFrom"),
    createdByActorId: str(ctx.actorId),
    createdByActorName: str(ctx.actorName),
    updatedByActorId: str(ctx.actorId),
    updatedByActorName: str(ctx.actorName),
    revision: 1,
  });
  return doc.toObject();
}

/** This company's version by id. Scoped, so another company's is NOT FOUND. */
async function requireOwn(ctx, id) {
  if (!mongoose.Types.ObjectId.isValid(str(id))) {
    throw fail("BOARD_POLICY_NOT_FOUND", "That policy version does not exist.", { reason: "NOT_FOUND" });
  }
  const doc = await BoardPolicy.findOne({ _id: id, companyId: ctx.companyId }).lean();
  if (!doc) {
    throw fail("BOARD_POLICY_NOT_FOUND", "That policy version does not exist.", { reason: "NOT_FOUND" });
  }
  return doc;
}

/**
 * Edit a draft.
 *
 * ── AND ONLY A DRAFT ────────────────────────────────────────────────────────
 * An approved version is immutable, and the refusal says so by name rather
 * than as a validation error: the request is well formed and the answer is
 * that this is not the kind of thing that gets edited. What the caller wants
 * is a new version, and the message says so.
 */
async function updateDraft(ctx, id, patch = {}) {
  const doc = await requireOwn(ctx, id);
  if (doc.status !== "DRAFT") {
    throw fail(
      "BOARD_POLICY_IMMUTABLE",
      "This policy has been approved by the Board and cannot be changed. Create a new version with a later effective date instead.",
      { reason: "APPROVED_IMMUTABLE", status: doc.status, remedy: "NEW_VERSION" },
    );
  }

  const expected = Number(patch.revision);
  if (!Number.isInteger(expected)) {
    throw bad("A change must say which version of the draft it was based on.", {
      field: "revision", reason: "BOARD_POLICY_REVISION_REQUIRED", currentRevision: doc.revision,
    });
  }
  if (expected !== doc.revision) {
    throw fail(
      "BOARD_POLICY_REVISION_CONFLICT",
      "This draft was changed by somebody else while you were editing it. Reload it and make your change again.",
      { reason: "BOARD_POLICY_REVISION_CONFLICT", expectedRevision: expected, currentRevision: doc.revision },
    );
  }

  const update = {
    updatedByActorId: str(ctx.actorId),
    updatedByActorName: str(ctx.actorName),
  };
  const contract = contractFor(doc.policyKey);
  if (Object.prototype.hasOwnProperty.call(patch, contract.field)) {
    update[contract.field] = contract.validate(patch[contract.field] || {}, doc[contract.field] || {});
  }
  if (Object.prototype.hasOwnProperty.call(patch, "rationale")) {
    update.rationale = str(patch.rationale).slice(0, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "effectiveFrom")) {
    const d = asDate(patch.effectiveFrom, "effectiveFrom");
    if (d) update.effectiveFrom = d;
    else update.$unset = { effectiveFrom: "" };
  }

  const { $unset, ...set } = update;
  const saved = await BoardPolicy.findOneAndUpdate(
    /* The revision is part of the FILTER: a stale writer matches nothing and
       changes nothing, rather than being told it won a race it lost. */
    { _id: doc._id, companyId: ctx.companyId, status: "DRAFT", revision: expected },
    { $set: set, ...($unset ? { $unset } : {}), $inc: { revision: 1 } },
    { new: true, runValidators: true },
  ).lean();

  if (!saved) {
    const now = await BoardPolicy.findById(doc._id).select("revision status").lean();
    if (now?.status !== "DRAFT") {
      throw fail("BOARD_POLICY_IMMUTABLE", "This policy was approved while you were editing it.", {
        reason: "APPROVED_IMMUTABLE", status: now?.status || null,
      });
    }
    throw fail("BOARD_POLICY_REVISION_CONFLICT", "This draft was changed by somebody else while you were editing it.", {
      reason: "BOARD_POLICY_REVISION_CONFLICT", currentRevision: now?.revision ?? null,
    });
  }
  return saved;
}

/**
 * Approve a draft, from a date.
 *
 * ── WHAT APPROVAL ACTUALLY IS ───────────────────────────────────────────────
 * A signature and a date, on a complete decision. All three are checked here
 * and none of them is optional:
 *
 *   · complete, because a half-stated methodology approved is a guess with the
 *     Board's name on it;
 *   · dated, because a rule with no start applies to everything ever costed,
 *     including what was quoted before anybody agreed it;
 *   · signed by the server from the authenticated actor, never from the body —
 *     an approver a request can name is not an approver.
 *
 * Nothing is written to the version this one takes over from. It is superseded
 * by the arithmetic of dates, and its record stays as it was approved.
 */
async function approve(ctx, id, { effectiveFrom = null } = {}) {
  const doc = await requireOwn(ctx, id);
  if (doc.status !== "DRAFT") {
    throw fail("BOARD_POLICY_IMMUTABLE", "This policy has already been approved.", {
      reason: "ALREADY_APPROVED", status: doc.status,
    });
  }

  const when = asDate(effectiveFrom, "effectiveFrom") || (doc.effectiveFrom ? new Date(doc.effectiveFrom) : null);
  if (!when) {
    throw fail("BOARD_POLICY_INCOMPLETE", "An approved policy needs a date it takes effect from.", {
      reason: "EFFECTIVE_FROM_REQUIRED", field: "effectiveFrom",
      gaps: [{ field: "effectiveFrom", message: "State the date this takes effect from." }],
    });
  }

  const gaps = gapsFor(doc);
  if (gaps.length) {
    throw fail(
      "BOARD_POLICY_INCOMPLETE",
      `This policy cannot be approved yet: ${gaps.length} decision${gaps.length === 1 ? " is" : "s are"} still open.`,
      { reason: "METHODOLOGY_INCOMPLETE", gaps },
    );
  }

  /* ── AND WHAT THIS VERSION MAY NOT TAKE AWAY ──────────────────────────
     Some payloads carry permanent identities. A development charge's KEY is
     what a style's requirement points at and what a costing frozen two years
     ago names, so a catalogue that silently dropped one would orphan the
     first and make the second unexplainable.

     Checked at APPROVAL rather than only while editing a draft, because a
     draft starts empty: within one draft "nothing was removed" is trivially
     true, and the removal that matters is against what the company actually
     has in force. Deactivating remains the way to withdraw a charge. */
  const contract = contractFor(doc.policyKey);
  if (contract.supersede) {
    const previous = await resolveEffective(ctx.companyId, doc.policyKey, when);
    if (previous) contract.supersede(doc[contract.field], previous[contract.field]);
  }

  /* Checked here for a useful message, and enforced by the unique index below
     for correctness — the two approvals that matter are the ones that race. */
  const clash = await BoardPolicy.findOne({
    companyId: ctx.companyId, policyKey: doc.policyKey,
    status: "BOARD_APPROVED", effectiveFrom: when,
  }).select("_id").lean();
  if (clash) {
    throw fail(
      "BOARD_POLICY_EFFECTIVE_DATE_TAKEN",
      "Another approved policy already takes effect on that date. Two policies cannot both be in force at once — choose a different date.",
      { reason: "EFFECTIVE_DATE_TAKEN", effectiveFrom: when, conflictsWith: String(clash._id) },
    );
  }

  try {
    const saved = await BoardPolicy.findOneAndUpdate(
      { _id: doc._id, companyId: ctx.companyId, status: "DRAFT" },
      {
        $set: {
          status: "BOARD_APPROVED",
          effectiveFrom: when,
          approvedAt: new Date(),
          approvedByActorId: str(ctx.actorId),
          approvedByActorName: str(ctx.actorName),
        },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!saved) {
      throw fail("BOARD_POLICY_IMMUTABLE", "This policy was approved while you were looking at it.", {
        reason: "ALREADY_APPROVED",
      });
    }
    return saved;
  } catch (err) {
    if (err?.code === 11000) {
      throw fail(
        "BOARD_POLICY_EFFECTIVE_DATE_TAKEN",
        "Another approved policy already takes effect on that date.",
        { reason: "EFFECTIVE_DATE_TAKEN", effectiveFrom: when },
      );
    }
    throw err;
  }
}

/**
 * Delete a draft.
 *
 * Only a draft, and it is the one destructive act this service has. An
 * approved version is a record of a decision the company made; removing it
 * would make its own frozen costings unexplainable.
 */
async function discardDraft(ctx, id) {
  const doc = await requireOwn(ctx, id);
  if (doc.status !== "DRAFT") {
    throw fail("BOARD_POLICY_IMMUTABLE", "An approved policy is a record of a decision and cannot be deleted.", {
      reason: "APPROVED_IMMUTABLE", status: doc.status,
    });
  }
  await BoardPolicy.deleteOne({ _id: doc._id, companyId: ctx.companyId, status: "DRAFT" });
  return { discarded: String(doc._id) };
}

/* ══ READING ═══════════════════════════════════════════════════════════════ */

/**
 * Every version of one policy for one company, newest first, with each one's
 * derived state and the one currently in force named.
 *
 * History is the point: a screen that shows only the current rate cannot
 * answer the question a Board actually asks, which is what changed and when.
 */
async function history(ctx, { policyKey = "FINANCING", asOf = new Date() } = {}) {
  const when = asDate(asOf, "asOf") || new Date();
  const all = await BoardPolicy.find({ companyId: ctx.companyId, policyKey })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean();

  const effective = all
    .filter((d) => d.status === "BOARD_APPROVED" && d.effectiveFrom && new Date(d.effectiveFrom) <= when)
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0] || null;

  return {
    policyKey,
    asOf: when,
    effectiveId: effective ? String(effective._id) : null,
    versions: all.map((d) => ({
      ...d,
      lifecycle: lifecycleOf(d, { asOf: when, latestEffectiveId: effective?._id || null }),
    })),
  };
}

module.exports = {
  lifecycleOf, resolveEffective, resolveState, POLICY_STATE,
  financingGaps, validateFinancing,
  overheadGaps, validateOverhead,
  labourGaps, validateLabour,
  gstGaps, validateGst,
  marginGaps, validateMargin,
  dutyGaps, validateDutyRules, supersedeDutyRules, mintDutyKey, assertNoDutyOverlap,
  contingencyGaps, validateContingency, CONTINGENCY_BASES,
  developmentChargeGaps, validateDevelopmentCharges, validateRatePeriods, mintChargeKey,
  supersedeDevelopmentCharges,
  CONTRACT, contractFor, gapsFor,
  createDraft, updateDraft, approve, discardDraft, history, requireOwn,
};
