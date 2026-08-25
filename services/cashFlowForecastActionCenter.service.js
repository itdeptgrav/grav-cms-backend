/**
 * GRAV-CMS-BACKEND/services/cashFlowForecastActionCenter.service.js
 *
 * CHUNK 1-G — what to clean up first, and where to go to do it. PURE: no
 * Mongo, no clock, no HTTP. Given already-fetched forecast output, party
 * impact analysis and a recurring-items count, it ranks the work.
 *
 * ── A GUIDANCE LAYER, NOT A DECISION LAYER ──────────────────────────────────
 * This file says WHERE attention is needed. It never says what the answer is:
 * no credit-days figure, no expected date, no recurring amount, no cash-ledger
 * selection. Every action carries an `href` to an existing explicit workflow
 * where a person supplies the value themselves. That boundary is the whole
 * design — a "helpful" default here would reintroduce, one layer up, exactly
 * the invented-number problem the rest of Chunk 1 spent six slices removing.
 *
 * ── AND NOT AN ALERT SYSTEM ─────────────────────────────────────────────────
 * `priority` orders a queue; it is not a severity. There are no thresholds, no
 * breach conditions and no warnings, and the copy is deliberately flat —
 * "Company default drives ₹X of projected dates" states a fact, where "⚠ 100%
 * of your forecast is unreliable!" would be a judgement this file has no
 * standing to make. Alerts are a later, explicit chunk.
 */

/** Small on purpose: a queue nobody reads to the bottom is not a queue. */
const MAX_ACTIONS = 8;

/** Room is reserved for the setup actions so a wall of parties cannot bury them. */
const MAX_PARTY_ACTIONS = 3;
const MAX_OVERDUE_ACTIONS = 3;

const TYPE = Object.freeze({
  PARTY_TERMS: "set_party_terms",
  OVERDUE_DATE: "set_overdue_expected_date",
  RECURRING: "add_recurring_items",
  CASH_LEDGERS: "review_cash_ledgers",
});

const PRIORITY = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });
const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

/**
 * The categories a forecast is usually wrong without.
 *
 * Payroll and rent are the two nearly every business has and which appear
 * nowhere in the books until posted — the exact gap the recurring register
 * exists to close. Deliberately not a longer list: naming categories a given
 * company genuinely does not have would be inventing obligations.
 */
const KEY_RECURRING_TYPES = Object.freeze(["payroll", "rent"]);

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function inr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
}

/**
 * How ready the Base forecast is to be relied on.
 *
 * Three states, and the thresholds are structural rather than numeric — "is
 * this configured", "is anything still derived or excluded" — because a
 * percentage cutoff would be a judgement about how much invention is
 * acceptable, which is not this file's to make.
 */
function scoreLabel({ cashConfigSaved, projectedSomething, defaultDerivedCount, overdueExcludedCount }) {
  // Unconfigured cash, or a forecast with nothing in it at all, is not a
  // forecast anyone should act on yet.
  if (!cashConfigSaved || !projectedSomething) return "Needs setup";
  if (defaultDerivedCount === 0 && overdueExcludedCount === 0) return "Ready for base use";
  return "Partially ready";
}

/**
 * Build the ranked action list.
 *
 * @param {object} input
 * @param {object} input.forecast — `sourceBreakdown`, `inclusion`,
 *   `excludedOverdue`, `openingCashConfig` from the forecast endpoint
 * @param {Array}  input.parties — the party-terms impact analysis, already ranked
 * @param {object} input.recurring — `{ activeCount, typesPresent }`
 */
function buildActionCenter({
  companyId = null,
  asOfDate = null,
  horizonDays = 90,
  forecast = {},
  parties = [],
  recurring = {},
} = {}) {
  const breakdown = forecast.sourceBreakdown || {};
  const inclusion = forecast.inclusion || {};
  const cashCfg = forecast.openingCashConfig || {};
  const defaultDerived = breakdown.companyDefaultDerived || { count: 0, amount: 0 };

  const cashConfigSaved = cashCfg.status === "saved";
  const projectedSomething =
    (inclusion.includedOpenItems || 0) > 0 || (inclusion.includedRecurringItems || 0) > 0;

  const summary = {
    // These two describe what is IN the projection, matching what the forecast
    // screen shows. Per-party action amounts below use each party's TOTAL
    // default-derived exposure instead, which is larger because it includes
    // bills currently excluded as overdue — those are exactly the ones better
    // terms would bring into view, so the action figure is the useful one.
    scoreLabel: scoreLabel({
      cashConfigSaved,
      projectedSomething,
      defaultDerivedCount: defaultDerived.count || 0,
      overdueExcludedCount: inclusion.excludedOverdueOpenItems || 0,
    }),
    defaultDerivedAmount: money(defaultDerived.amount),
    defaultDerivedCount: defaultDerived.count || 0,
    overdueExcludedAmount: money(inclusion.excludedOverdueAmount),
    overdueExcludedCount: inclusion.excludedOverdueOpenItems || 0,
    recurringActiveCount: Number(recurring.activeCount) || 0,
    openingCashConfigStatus: cashCfg.status || "suggested_default",
  };

  const candidates = [];

  /* ── Party terms ─────────────────────────────────────────────────────── */
  const withDefaults = (parties || []).filter((p) => (p.companyDefaultDerivedAmount || 0) > 0);

  withDefaults.forEach((p, i) => {
    const isTop = i < MAX_PARTY_ACTIONS;
    candidates.push({
      id: `party_terms:${p.ledgerId}`,
      type: TYPE.PARTY_TERMS,
      priority: isTop ? PRIORITY.HIGH : PRIORITY.LOW,
      title: `Set party terms for ${p.ledgerName}`,
      description:
        `${p.companyDefaultDerivedCount} bill${p.companyDefaultDerivedCount === 1 ? "" : "s"} ` +
        `are dated from the company default rather than this party's own terms.`,
      amount: money(p.companyDefaultDerivedAmount),
      count: p.companyDefaultDerivedCount || 0,
      targetLabel: p.ledgerName,
      targetId: p.ledgerId,
      href: "/accountant/settings#party-terms",
      // The party's own measured facts — never a suggested number of days.
      reason: `Company default drives ${inr(p.companyDefaultDerivedAmount)} of projected dates. ${p.suggestedPriorityReason || ""}`.trim(),
      ctaLabel: "Preview impact",
      sortAmount: p.companyDefaultDerivedAmount || 0,
    });
  });

  /* ── Overdue expected dates ──────────────────────────────────────────── */
  // Grouped by party rather than one action per bill: a queue with 117 rows in
  // it is a list, not guidance, and the person chasing them chases a party.
  const overdueByParty = new Map();
  for (const it of forecast.excludedOverdue || []) {
    const key = it.ledgerId || it.partyOrLedgerName || "unattributed";
    if (!overdueByParty.has(key)) {
      overdueByParty.set(key, {
        ledgerId: it.ledgerId || null,
        name: it.partyOrLedgerName || "Unattributed",
        amount: 0,
        count: 0,
        oldestAgeDays: 0,
      });
    }
    const e = overdueByParty.get(key);
    e.amount += Math.abs(Number(it.amount) || 0);
    e.count += 1;
    e.oldestAgeDays = Math.max(e.oldestAgeDays, Number(it.ageDays) || 0);
  }

  [...overdueByParty.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_OVERDUE_ACTIONS)
    .forEach((g) => {
      candidates.push({
        id: `overdue:${g.ledgerId || g.name}`,
        type: TYPE.OVERDUE_DATE,
        priority: PRIORITY.HIGH,
        title: `Add expected dates for ${g.name}`,
        description:
          `${g.count} overdue bill${g.count === 1 ? "" : "s"} are excluded from the forecast ` +
          `because nobody has said when they are expected.`,
        amount: money(g.amount),
        count: g.count,
        targetLabel: g.name,
        targetId: g.ledgerId,
        href: "#overdue",
        reason: `${inr(g.amount)} is not projected. Oldest is ${g.oldestAgeDays} days past due.`,
        ctaLabel: "Review overdue",
        sortAmount: g.amount,
      });
    });

  /* ── Recurring register ──────────────────────────────────────────────── */
  const activeCount = Number(recurring.activeCount) || 0;
  const typesPresent = new Set(recurring.typesPresent || []);
  const missingKey = KEY_RECURRING_TYPES.filter((t) => !typesPresent.has(t));

  if (activeCount === 0) {
    candidates.push({
      id: "recurring:empty",
      type: TYPE.RECURRING,
      priority: PRIORITY.MEDIUM,
      title: "Add recurring payroll and rent schedules",
      description:
        "The recurring register is empty, so the forecast contains no salary, rent or other " +
        "scheduled payments.",
      amount: null,
      count: 0,
      targetLabel: null,
      targetId: null,
      href: "/accountant/recurring-items",
      reason: "Predictable outgoings appear nowhere in the books until they are posted.",
      ctaLabel: "Open register",
      sortAmount: 0,
    });
  } else if (missingKey.length > 0) {
    candidates.push({
      id: `recurring:missing:${missingKey.join("-")}`,
      type: TYPE.RECURRING,
      priority: PRIORITY.MEDIUM,
      title: `Add recurring ${missingKey.join(" and ")} schedules`,
      description: `${activeCount} recurring item${activeCount === 1 ? "" : "s"} exist, but no ${missingKey.join(" or ")} schedule.`,
      amount: null,
      count: activeCount,
      targetLabel: null,
      targetId: null,
      href: "/accountant/recurring-items",
      reason: "These are the outgoings a forecast is most often missing.",
      ctaLabel: "Open register",
      sortAmount: 0,
    });
  }

  /* ── Cash ledger config ──────────────────────────────────────────────── */
  if (!cashConfigSaved) {
    candidates.push({
      id: "cash_ledgers:unsaved",
      type: TYPE.CASH_LEDGERS,
      priority: PRIORITY.MEDIUM,
      title: "Review operating cash ledgers",
      description:
        "Opening cash currently counts every cash, bank and overdraft ledger, which may include " +
        "personal or borrowing accounts.",
      amount: null,
      count: cashCfg.includedLedgerCount || 0,
      targetLabel: null,
      targetId: null,
      href: "/accountant/settings#cash-ledgers",
      reason: "The selection has not been confirmed, so the default is in force.",
      ctaLabel: "Review selection",
      sortAmount: 0,
    });
  }

  const actions = candidates
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.sortAmount - a.sortAmount,
    )
    .slice(0, MAX_ACTIONS)
    // `sortAmount` is an ordering key, not an output field.
    .map(({ sortAmount, ...rest }) => rest);

  return { companyId, asOfDate, horizonDays, summary, actions };
}

module.exports = {
  MAX_ACTIONS,
  MAX_PARTY_ACTIONS,
  MAX_OVERDUE_ACTIONS,
  KEY_RECURRING_TYPES,
  TYPE,
  PRIORITY,
  scoreLabel,
  buildActionCenter,
};
