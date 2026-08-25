/**
 * GRAV-CMS-BACKEND/services/budgetOverlap.service.js
 *
 * Which budget owns a voucher, when more than one covers it.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ───────────────────────────────────────────
 * The dashboard builds its headline by evaluating each budget's own lines and
 * summing across budgets. Every figure per budget is right. The SUM is not:
 *
 *     FY26-27 Company Budget   Freight   allocated 56,00,000
 *     Freight — Q2             Freight   allocated 13,00,000   (Q2 is inside the FY)
 *     one 1,00,000 purchase voucher in August
 *       → counted in BOTH budgets' roll-ups
 *       → totals.expense.actual reads 2,00,000
 *
 * On the first demo dataset this inflated total spend by 42%. Nobody had
 * mis-entered anything; running a tight quarter inside a yearly envelope is an
 * ordinary thing to do, and doing it made the headline lie.
 *
 * ── WHY ALLOCATIONS ARE NOT DEDUPLICATED, ONLY ACTUALS ──────────────────────
 * Two budgets each allocating to a head genuinely do authorise the sum — that
 * is what a supplementary quarter budget MEANS, and budget control on posting
 * is right to add them up. But the ONE payment that followed is one payment.
 * Allocation is a promise and can legitimately be made twice; spend is an
 * event and happened once. So this module touches actuals and nothing else.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * The most specific budget owns the money:
 *
 *   1. scope         project ▸ department ▸ company
 *   2. narrower period wins   a Q2 budget beats the year it sits inside
 *   3. later createdAt wins   the budget drawn up more recently is the more
 *                             deliberate statement about this head
 *   4. budget id, then line id, ascending — never reached for a real decision,
 *                             present so the same data always totals the same
 *
 * A decision reaching rule 4 is genuinely arbitrary and is COUNTED as
 * ambiguous, so the route can say so rather than let an arbitrary pick look
 * like a considered one.
 *
 * Everything here is pure. The route supplies candidates and movements; this
 * decides. That keeps the rule testable without a database and keeps it in one
 * place, rather than spread through an aggregation pipeline where changing it
 * means changing a query.
 */

/** Lower rank wins. An unknown or unset scope IS company — the same
 *  normalisation the list and dashboard filters make for pre-scope rows. */
const SCOPE_RANK = { project: 0, department: 1, company: 2 };

function scopeRank(scope) {
  const r = SCOPE_RANK[scope];
  return r === undefined ? SCOPE_RANK.company : r;
}

const ms = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * One line of one budget, reduced to what the decision needs.
 *
 * `key` identifies the line uniquely across budgets so the caller can put the
 * won amounts back where they came from.
 */
function candidateFrom(budget, line) {
  if (!budget || !line || !line.ledgerId) return null;
  const startMs = ms(budget.startDate);
  const endMs = ms(budget.endDate);
  /* A budget with no usable window cannot claim a voucher by date, and
   * treating a missing bound as "forever" would let one malformed row take
   * every voucher off every well-formed budget. */
  if (startMs === null || endMs === null || endMs < startMs) return null;

  return {
    key: `${budget._id}:${line._id}`,
    budgetId: String(budget._id),
    lineId: String(line._id),
    ledgerId: String(line.ledgerId),
    nature: line.nature === "revenue" ? "revenue" : "expense",
    scope: budget.scope || "company",
    startMs,
    endMs,
    /* Inclusive of both ends, matching the $gte/$lte the actuals aggregate
     * uses. A span is a count of milliseconds covered, so the narrower of two
     * periods is simply the smaller number. */
    spanMs: endMs - startMs,
    createdAtMs: ms(budget.createdAt) ?? 0,
  };
}

/**
 * Negative when `a` should own the voucher. Total order — never returns 0 for
 * two distinct lines, because a comparator that ties leaves the winner to the
 * sort's implementation.
 */
function compareCandidates(a, b) {
  const scope = scopeRank(a.scope) - scopeRank(b.scope);
  if (scope !== 0) return scope;

  const span = a.spanMs - b.spanMs;
  if (span !== 0) return span;

  const created = b.createdAtMs - a.createdAtMs;
  if (created !== 0) return created;

  if (a.budgetId !== b.budgetId) return a.budgetId < b.budgetId ? -1 : 1;
  if (a.lineId !== b.lineId) return a.lineId < b.lineId ? -1 : 1;
  return 0;
}

/** True when the choice between these two came down to rule 4 — i.e. nothing
 *  about either budget actually distinguishes them. */
function isArbitraryTie(a, b) {
  return (
    scopeRank(a.scope) === scopeRank(b.scope) &&
    a.spanMs === b.spanMs &&
    a.createdAtMs === b.createdAtMs
  );
}

/** A voucher belongs to a line's period if its date falls inside it, on the
 *  same inclusive bounds the actuals aggregation matched on. */
function covers(candidate, dateMs) {
  return dateMs !== null && dateMs >= candidate.startMs && dateMs <= candidate.endMs;
}

/**
 * Assign every movement to exactly one line.
 *
 * `movements` are (ledger, voucher) rows — one voucher touching two contested
 * heads is two movements, and each is decided on its own, because the two
 * heads may well be owned by different budgets.
 *
 * Returns `won`, a Map of candidate key → { debit, credit, voucherCount }, for
 * EVERY candidate passed in — including the ones that won nothing, which must
 * read zero rather than fall back to their un-deduplicated figure.
 */
function assignMovements({ candidates = [], movements = [] } = {}) {
  const byLedger = new Map();
  const won = new Map();

  for (const c of candidates) {
    if (!c) continue;
    won.set(c.key, { debit: 0, credit: 0, voucherCount: 0 });
    if (!byLedger.has(c.ledgerId)) byLedger.set(c.ledgerId, []);
    byLedger.get(c.ledgerId).push(c);
  }
  /* Sorted once per head rather than per voucher: the order does not depend on
   * the voucher, only on the budgets. */
  for (const list of byLedger.values()) list.sort(compareCandidates);

  let contestedMovements = 0;
  let ambiguousMovements = 0;
  let unclaimedMovements = 0;
  let duplicateSigned = 0;

  for (const m of movements) {
    const list = byLedger.get(String(m.ledgerId));
    if (!list || !list.length) continue;

    const dateMs = ms(m.voucherDate);
    const eligible = list.filter((c) => covers(c, dateMs));

    if (!eligible.length) {
      /* Inside the queried window but outside every line's own period — the
       * union window is wider than any single budget's. Owned by nobody, so
       * counted by nobody. */
      unclaimedMovements += 1;
      continue;
    }

    /* `list` is already in precedence order, so filtering preserves it. */
    const winner = eligible[0];
    const bucket = won.get(winner.key);
    bucket.debit += m.debit || 0;
    bucket.credit += m.credit || 0;
    bucket.voucherCount += 1;

    if (eligible.length > 1) {
      contestedMovements += 1;
      /* What the old roll-up counted over and above the truth: every loser
       * was also adding this movement to the headline. */
      duplicateSigned += ((m.debit || 0) - (m.credit || 0)) * (eligible.length - 1);
      if (isArbitraryTie(winner, eligible[1])) ambiguousMovements += 1;
    }
  }

  return {
    won,
    stats: {
      contestedMovements,
      ambiguousMovements,
      unclaimedMovements,
      duplicateSigned,
    },
  };
}

/**
 * Which heads are claimed by more than one line, and therefore need the
 * per-voucher pass at all.
 *
 * Deliberately keyed on LINES rather than budgets: one budget carrying the
 * same head on two rows double-counts itself in exactly the same way, and is
 * fixed by exactly the same assignment.
 */
function contestedLedgers(candidates = []) {
  const counts = new Map();
  for (const c of candidates) {
    if (!c) continue;
    counts.set(c.ledgerId, (counts.get(c.ledgerId) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

module.exports = {
  SCOPE_RANK,
  scopeRank,
  candidateFrom,
  compareCandidates,
  isArbitraryTie,
  covers,
  assignMovements,
  contestedLedgers,
};
