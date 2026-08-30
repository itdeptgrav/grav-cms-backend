"use strict";
/**
 * services/budgetClassification.service.js
 *
 * WHICH LEDGERS CAN CARRY A BUDGET, AND WHICH CANNOT.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * Budget control used to read `nature` — asset / liability / equity / revenue /
 * expense — straight off the group tree, and treat every expense head as
 * budgetable. That is right for most of the chart and wrong in two directions
 * that both bite:
 *
 *   Round Off is an expense. So is Suspense. Neither is spend anybody budgets,
 *   yet both showed up as budget heads and reported themselves "unbudgeted"
 *   on perfectly ordinary vouchers.
 *
 *   And nothing distinguished a head somebody deliberately budgets (Software
 *   Subscriptions) from a posting ledger the bookkeeping happens to use
 *   (Purchase — Local). Both are expenses; only one is a control.
 *
 * ── THREE VALUES, DELIBERATELY ──────────────────────────────────────────────
 *   expense_budget   controllable spend — a cap somebody approves and watches
 *   revenue_target   income — a floor to reach, never a cap on spending
 *   not_budgeted     everything else: never offered, never checked, never
 *                    reported as missing a budget
 *
 * There is no `procurement_budget`. Raw material, consumables, job work,
 * freight and packing are all controllable spend and all `expense_budget` —
 * splitting them into their own kind would multiply the pickers without
 * changing a single rule about who approves what.
 *
 * ── COMPUTED, WITH A MANUAL OVERRIDE THAT WINS ──────────────────────────────
 * `classify()` derives a value from nature, group and name. `budgetControlOf()`
 * returns the STORED value when finance has set one and the derived value
 * otherwise — so the whole system behaves correctly before the backfill has
 * ever run, and the backfill becomes an optimisation rather than a
 * precondition. A ledger finance has ruled on is never re-derived.
 *
 * NOTE ON NAMING: `budgetControl.service.js` is the voucher-time availability
 * check. This is the classification layer it reads. Different concerns, and
 * the field on the ledger is `budgetControl` because that is what it controls
 * — not because it belongs to that service.
 */

const EXPENSE_BUDGET = "expense_budget";
const REVENUE_TARGET = "revenue_target";
const NOT_BUDGETED = "not_budgeted";

const VALUES = [EXPENSE_BUDGET, REVENUE_TARGET, NOT_BUDGETED];

/** What finance sees in the override dropdown. */
const LABEL = {
  [EXPENSE_BUDGET]: "Expense budget",
  [REVENUE_TARGET]: "Revenue target",
  [NOT_BUDGETED]: "Not budgeted",
};

/* ── HEADS THAT ARE NEVER BUDGETED, WHATEVER THEIR NATURE ────────────────────
 * Structural: these are never spend anybody plans, whatever the chart says
 * their nature is. Round Off and Suspense are expense-natured and budget heads
 * by nobody's intention. */
const NEVER_BUDGETED_PATTERNS = [
  /\bround[\s-]?off\b/i,
  /\brounding\b/i,
  /\bsuspense\b/i,
  /\bcontra\b/i,
  /\bopening\s+stock\b/i,
  /\bclosing\s+stock\b/i,
  /\bstock[\s-]?in[\s-]?hand\b/i,
  /\binventory\s+(account|balance)\b/i,
  /\bprofit\s*(&|and)?\s*loss\s+a\/?c\b/i,
  /\bcapital\s+account\b/i,
  /\bdrawings\b/i,
  /\bretained\s+earnings\b/i,
];

/* ── TAX CONTROL ACCOUNTS ────────────────────────────────────────────────────
 * Deliberately NARROW, and deliberately separate from the list above.
 *
 * A first draft matched a bare /\bgst\b/ and swallowed three legitimate
 * expense heads the moment it met real data:
 *
 *     Freight Charges With 18% GST        → freight IS controllable spend
 *     Professional Fees for GST Registration → professional fees ARE spend
 *     Purchase Account Non-GST            → a purchase account
 *
 * Mentioning a tax is not being a tax account. These patterns match the
 * CONTROL-ACCOUNT shape instead: the tax term leading the name, or followed by
 * input/output/payable/receivable/credit. "Audit & Tax Consultancy Fees" and
 * the three above all fall through correctly.
 *
 * They are also only applied to heads that are not already expense or revenue
 * by nature — a real tax control account is a balance-sheet account, and one
 * mis-parented under an expense group is rare enough to be worth a human look
 * (the backfill lists it) rather than a rule that misfires on real spend. */
const TAX_CONTROL_PATTERNS = [
  /^\s*(c|s|i|ut)?gst\b/i,
  /^\s*(input|output)\s+(c|s|i|ut)?gst\b/i,
  /\b(c|s|i|ut)?gst\s+(input|output|payable|receivable|credit|recoverable)\b/i,
  /\b(input|output)\s+(tax|credit)\b/i,
  /^\s*tds\b/i,
  /^\s*tcs\b/i,
  /\btds\s+(payable|receivable|deducted|collected)\b/i,
  /\btcs\s+(payable|receivable|collected)\b/i,
  /\bcess\s+(payable|receivable|input|output)\b/i,
  /\bduties\s*(&|and)?\s*taxes\b/i,
];

/** Groups whose members are structurally never budget heads. */
const NEVER_BUDGETED_GROUPS = [
  /^duties\s*(&|and)?\s*taxes$/i,
  /^sundry\s+debtors$/i,
  /^sundry\s+creditors$/i,
  /^bank\s+accounts?$/i,
  /^bank\s+od/i,
  /^cash[\s-]?in[\s-]?hand$/i,
  /^fixed\s+assets?$/i,
  /^investments?$/i,
  /^current\s+assets?$/i,
  /^current\s+liabilit(y|ies)$/i,
  /^loans?/i,
  /^secured\s+loans?$/i,
  /^unsecured\s+loans?$/i,
  /^capital\s+account$/i,
  /^reserves/i,
  /^stock[\s-]?in[\s-]?hand$/i,
  /^deposits?/i,
  /^provisions?$/i,
  /^suspense/i,
  /^branch/i,
];

const matchesAny = (value, patterns) => {
  const s = String(value || "").trim();
  if (!s) return false;
  return patterns.some((re) => re.test(s));
};

/**
 * Derive a classification from what the chart of accounts already says.
 *
 * @param {object} ledger  { name, groupName, nature }
 * @returns {"expense_budget"|"revenue_target"|"not_budgeted"}
 */
function classify(ledger = {}) {
  const name = ledger.name || "";
  const groupName = ledger.groupName || "";
  const nature = String(ledger.nature || "").toLowerCase();

  /* Name and group rules run FIRST, and beat nature. They exist precisely for
     the heads whose nature is misleading — an expense-natured Round Off, a
     tax control account an import parented under the wrong group. */
  /* Structural rules beat nature — an expense-natured Round Off is still not
     a budget head. */
  if (matchesAny(name, NEVER_BUDGETED_PATTERNS)) return NOT_BUDGETED;
  if (matchesAny(groupName, NEVER_BUDGETED_PATTERNS)) return NOT_BUDGETED;
  if (matchesAny(groupName, NEVER_BUDGETED_GROUPS)) return NOT_BUDGETED;

  /* Tax CONTROL accounts, and only those. Not applied to expense- or
     revenue-natured heads: see the note on TAX_CONTROL_PATTERNS for the three
     real expense heads a broader rule wrongly caught. */
  const isPnl = nature === "expense" || nature === "revenue";
  if (!isPnl && (matchesAny(name, TAX_CONTROL_PATTERNS) || matchesAny(groupName, TAX_CONTROL_PATTERNS))) {
    return NOT_BUDGETED;
  }

  if (nature === "revenue") return REVENUE_TARGET;
  if (nature === "expense") return EXPENSE_BUDGET;

  /* asset, liability, equity — and anything unresolved. An unresolved nature
     lands here on purpose: a mis-parented ledger should drop OUT of budget
     control rather than into it, because the failure mode of guessing "this
     is spend" is refusing a legitimate posting. */
  return NOT_BUDGETED;
}

/**
 * The classification actually in force for a ledger.
 *
 * Finance's stored decision wins; otherwise it is derived. This is what every
 * caller should use — never `ledger.budgetControl` directly, which is absent
 * on every ledger written before this existed.
 */
function budgetControlOf(ledger = {}) {
  const stored = String(ledger.budgetControl || "");
  if (VALUES.includes(stored)) return stored;
  return classify(ledger);
}

/** Can spend be budgeted against this head? */
const isExpenseBudget = (ledger) => budgetControlOf(ledger) === EXPENSE_BUDGET;
/** Is this head a revenue target? */
const isRevenueTarget = (ledger) => budgetControlOf(ledger) === REVENUE_TARGET;
/** Should this head be ignored by every budget screen and check? */
const isNotBudgeted = (ledger) => budgetControlOf(ledger) === NOT_BUDGETED;

/**
 * Did the derivation have to guess?
 *
 * A ledger whose nature is missing, or whose group says one thing and whose
 * name says another, is worth a human look — the backfill logs these rather
 * than quietly asserting an answer.
 */
function isAmbiguous(ledger = {}) {
  const nature = String(ledger.nature || "").toLowerCase();
  if (!nature) return true;
  /* An expense-natured head caught by a never-budgeted rule: the two sources
     disagree, and the rule won. Correct, and worth being able to review. */
  if (
    (nature === "expense" || nature === "revenue") &&
    classify(ledger) === NOT_BUDGETED
  ) {
    return true;
  }
  return false;
}

module.exports = {
  EXPENSE_BUDGET,
  REVENUE_TARGET,
  NOT_BUDGETED,
  VALUES,
  LABEL,
  classify,
  budgetControlOf,
  isExpenseBudget,
  isRevenueTarget,
  isNotBudgeted,
  isAmbiguous,
};
