/**
 * GRAV-CMS-BACKEND/services/budgetTracker.service.js
 *
 * The DEPARTMENT's view of its own approved budget: what finance approved,
 * what has actually been spent or earned against it, and where that stands
 * per budget head.
 *
 * ── WHY THIS IS NOT THE ACCOUNTANT DASHBOARD ────────────────────────────────
 * `/api/accountant/budgets/dashboard` answers the same question for finance,
 * across every department, and returns company-wide totals, other departments'
 * names, pending approval queues and cost-centre bindings. A department head
 * may see none of that. This module projects the SAME evaluated lines down to
 * the subset one department is entitled to, and drops everything else on the
 * way out — so the two screens cannot disagree about a number, and the narrow
 * one cannot accidentally widen.
 *
 * The arithmetic is not re-implemented here. Lines arrive already hydrated by
 * budgetActuals and evaluated by budgetVariance; this file groups, projects
 * and phases them. A second copy of "what is spend" is exactly how two screens
 * start reporting two different answers for one head.
 *
 * ── WHAT "SPENT" MEANS ──────────────────────────────────────────────────────
 * Posted vouchers only, from budgetActuals — the same source the trial balance
 * reads. Drafts, pending-approval and Tally's optional planning entries are
 * not money. A head bound to a cost centre counts only what was tagged to it,
 * and says so, because a bound line reading zero beside a head that moved
 * lakhs is a tagging problem, not an underspend.
 */

const phasing = require("./budgetPhasing.service");

/** Anything non-finite becomes 0. A NaN reaching a total poisons the screen. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * One head, as a department may see it.
 *
 * Deliberately omits `costCentreId`, `_id`, the owning budget's other lines,
 * and every field naming another department. `costCentreBound` and
 * `unattributed` survive because they are the only way to explain a zero
 * honestly — but the centre's identity does not.
 */
function publicHead(line, budget = {}) {
  if (!line) return null;
  const bound = Boolean(line.costCentreBound);
  return {
    ledgerId: line.ledgerId ? String(line.ledgerId) : null,
    ledgerName: line.ledgerName || "Unnamed head",
    groupName: line.groupName || null,
    nature: line.nature === "revenue" ? "revenue" : line.nature === "other" ? "other" : "expense",
    department: line.department || null,

    /* Which request this line came from, when it came from one. The
       department already holds its own requests, so this is the join key that
       lets the app say "finance agreed 4L against the 6L you asked for" —
       matching on ledger alone would guess wrong the moment a head is agreed
       twice. Department-safe: it names the caller's OWN request. */
    sourceRequestId: line.sourceRequestId ? String(line.sourceRequestId) : null,

    /* The allocation line's own id. The department needs it to raise an
       adjustment against this exact line — the ledger alone is not enough,
       because one head can carry two allocations in the same year. */
    lineId: line._id ? String(line._id) : null,

    budgetId: budget._id ? String(budget._id) : null,
    budgetName: budget.name || null,
    financialYear: budget.financialYear || null,

    approved: num(line.allocated ?? line.allocatedAmount),
    actual: num(line.actual),
    /* Expense: money still available. Revenue: how much is left to earn. Kept
       under different names because reading "remaining" on a revenue target as
       headroom is the opposite of what it means. */
    remaining: line.remaining === null || line.remaining === undefined ? null : num(line.remaining),
    toGo: line.toGo === null || line.toGo === undefined ? null : num(line.toGo),

    variance: num(line.variance),
    variancePct: line.variancePct === null || line.variancePct === undefined ? null : num(line.variancePct),
    favourable: Boolean(line.favourable),
    utilizationPct:
      line.utilizationPct === null || line.utilizationPct === undefined
        ? null
        : num(line.utilizationPct),

    /* Where the plan says this head should be by now — the whole reason the
       monthly phasing work exists. Null when the window cannot be read. */
    expectedToDate:
      line.expectedToDate === null || line.expectedToDate === undefined
        ? null
        : num(line.expectedToDate),
    paceGap: line.paceGap === null || line.paceGap === undefined ? null : num(line.paceGap),
    pace: line.pace || null,
    severity: line.severity || null,

    voucherCount: num(line.voucherCount),
    /* A head nobody bound to a ledger has no actuals and never will. Said out
       loud so the row reads "not tracked" rather than "nothing spent". */
    unbound: Boolean(line.unbound),
    costCentreBound: bound,
    unattributed: bound ? num(line.unattributed) : null,
  };
}

/**
 * The same head budgeted in two different budgets is ONE management question.
 * Merged on the ledger, with the contributing budgets named — an unbound line
 * has no head to merge on and keeps its own row.
 */
function mergeHeads(heads = []) {
  const out = new Map();
  let anon = 0;
  for (const h of heads) {
    if (!h) continue;
    const key = h.ledgerId ? `${h.nature}::${h.ledgerId}` : `anon::${(anon += 1)}`;
    const prev = out.get(key);
    if (!prev) {
      /* The merge key travels with the row. Two unbound heads sharing a name
         are two separate rows, and a caller keying a list on nature+ledgerId
         would collapse them into one — silently dropping a budget line. */
      out.set(key, {
        ...h,
        key,
        budgets: h.budgetName ? [h.budgetName] : [],
        /* One head can be funded by more than one agreed request. Kept as a
           list so the trace can say so rather than picking one and implying
           the others do not exist. */
        sourceRequestIds: h.sourceRequestId ? [h.sourceRequestId] : [],
        lineIds: h.lineId ? [h.lineId] : [],
      });
      continue;
    }
    prev.approved += h.approved;
    prev.actual += h.actual;
    prev.variance += h.variance;
    if (prev.remaining !== null && h.remaining !== null) prev.remaining += h.remaining;
    if (prev.toGo !== null && h.toGo !== null) prev.toGo += h.toGo;
    if (prev.expectedToDate !== null && h.expectedToDate !== null) {
      prev.expectedToDate += h.expectedToDate;
    }
    prev.voucherCount += h.voucherCount;
    /* Re-derived from the merged pair rather than averaged — averaging two
       percentages of different denominators is meaningless. */
    prev.utilizationPct = prev.approved > 0 ? (prev.actual / prev.approved) * 100 : null;
    prev.variancePct = prev.approved > 0 ? (prev.variance / prev.approved) * 100 : null;
    prev.paceGap =
      prev.expectedToDate === null
        ? null
        : prev.nature === "revenue"
          ? prev.actual - prev.expectedToDate
          : prev.expectedToDate - prev.actual;
    prev.favourable = prev.variance >= 0;
    if (h.budgetName && !prev.budgets.includes(h.budgetName)) prev.budgets.push(h.budgetName);
    if (h.sourceRequestId && !prev.sourceRequestIds.includes(h.sourceRequestId)) {
      prev.sourceRequestIds.push(h.sourceRequestId);
    }
    if (h.lineId && !prev.lineIds.includes(h.lineId)) prev.lineIds.push(h.lineId);
    prev.unbound = prev.unbound && h.unbound;
  }
  return [...out.values()];
}

/**
 * Totals, split by nature and never across it.
 *
 * An approved expense budget and an approved revenue target are opposite kinds
 * of number; one figure adding them is unreconcilable with anything. `other`
 * (a line sitting on an asset or liability head) is counted so it is not lost,
 * and kept outside both.
 */
function totals(heads = []) {
  const seed = () => ({ approved: 0, actual: 0, remaining: 0, expectedToDate: 0, count: 0 });
  const revenue = seed();
  const expense = seed();
  const other = seed();
  let untracked = 0;

  for (const h of heads) {
    if (!h) continue;
    const b = h.nature === "revenue" ? revenue : h.nature === "other" ? other : expense;
    b.approved += h.approved;
    b.actual += h.actual;
    b.expectedToDate += num(h.expectedToDate);
    b.count += 1;
    if (h.unbound) untracked += 1;
  }
  revenue.remaining = Math.max(0, revenue.approved - revenue.actual);
  expense.remaining = expense.approved - expense.actual;
  other.remaining = other.approved - other.actual;

  return {
    revenue,
    expense,
    other,
    hasRevenue: revenue.count > 0,
    hasExpense: expense.count > 0,
    /* Heads with no ledger binding, so their actuals can never arrive. The
       screen must be able to say how much of the picture is not tracked. */
    untracked,
    headCount: heads.length,
  };
}

/**
 * Planned against actual, month by month — the shape of the year.
 *
 * Planned comes from each line's own phasing (custom monthly, legacy weights,
 * or an even spread) via budgetPhasing, so a head loaded into March plans into
 * March. Actual comes from posted vouchers, already grouped by IST month.
 */
function monthlySeries({ lines = [], movements = [], from, to, nature = "expense" }) {
  const months = phasing.monthsInPeriod(from, to);
  if (!months.length) return [];

  const planned = new Map(months.map((m) => [m, 0]));
  const actual = new Map(months.map((m) => [m, 0]));
  const wanted = new Set();

  for (const line of lines) {
    if (!line) continue;
    const kind = line.nature === "revenue" ? "revenue" : line.nature === "other" ? "other" : "expense";
    if (kind !== nature) continue;
    if (line.ledgerId) wanted.add(String(line.ledgerId));

    /* `plannedByMonth` returns a Map keyed by IST month. Its parameter is
       `amount`, not the line's own field name — the service is deliberately
       ignorant of where the number came from. */
    const split = phasing.plannedByMonth({
      amount: num(line.allocated ?? line.allocatedAmount),
      phasingMode: line.phasingMode,
      monthlyPhasing: line.monthlyPhasing,
      phasing: line.phasing,
      startDate: from,
      endDate: to,
    });
    for (const [key, amount] of split) {
      if (planned.has(key)) planned.set(key, planned.get(key) + num(amount));
    }
  }

  for (const row of movements) {
    if (!row || !actual.has(row.key)) continue;
    if (!wanted.has(String(row.ledgerId))) continue;
    /* Expense heads move on the debit side, revenue on the credit side — the
       same rule budgetActuals.actualFrom applies to the period total. */
    const v = nature === "revenue" ? num(row.credit) - num(row.debit) : num(row.debit) - num(row.credit);
    actual.set(row.key, actual.get(row.key) + v);
  }

  return months.map((key) => ({
    key,
    planned: planned.get(key) || 0,
    actual: actual.get(key) || 0,
  }));
}

module.exports = {
  num,
  publicHead,
  mergeHeads,
  totals,
  monthlySeries,
};
