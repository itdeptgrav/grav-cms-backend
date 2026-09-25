"use strict";
/**
 * services/lineAllocation.service.js
 *
 * HOW MUCH OF AN APPROVED REQUEST EACH LINE IS COMMITTING.
 *
 * ── WHY THIS IS PURE, AND ON ITS OWN ────────────────────────────────────────
 * Splitting one approved total across several budget heads is arithmetic with
 * exactly one acceptable outcome: the parts add up to the whole, to the paise.
 * A rounding rule that lives inside an approval handler is one nobody can test
 * against a hundred awkward totals, and the failure mode — a paise that
 * appears or vanishes — is invisible until a year-end reconciliation.
 *
 * So: no database, no request object, no Mongoose. Numbers in, numbers out.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *   1. a line's own figure is `lineTotal` when it is a usable number
 *   2. otherwise `amount + taxAmount`
 *   3. an explicit 0 is a real figure and survives; absent is not 0
 *   4. negative or non-finite refuses the whole thing
 *
 * The sum of those is what the LINES say. The request's `grandTotal` is what
 * FINANCE APPROVED. They differ whenever a header-level discount, freight
 * charge or round-off was applied to the document rather than to a line, and
 * the approved figure is the one that must be committed — so the difference is
 * spread back across the lines proportionally.
 *
 * ── AND WHY THE REMAINDER GOES ON THE LAST LINE ─────────────────────────────
 * Proportional shares almost never divide into whole paise. Rounding each
 * share independently loses or gains up to one paise per line, so the last
 * eligible line takes whatever is left over after every other share is fixed.
 * That is deterministic — same input, same output, every time — and it is the
 * only placement that cannot drift: the remainder is computed from the total,
 * not accumulated from the shares.
 */

/** Money as paise, so nothing is ever compared or summed in floating rupees. */
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(paise) / 100;

/** A figure that is present and usable, as distinct from absent. */
const usable = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/**
 * What one line says it costs, before any header adjustment.
 *
 * @returns {{ok: true, paise: number, basis: string}|{ok:false}}
 */
function lineAmountOf(line = {}, index = 0) {
  const at = `Line ${index + 1}${line.name ? ` (${line.name})` : ""}`;

  /* ── `lineTotal` FIRST, BECAUSE IT IS WHAT WAS APPROVED ──────────────────
     It is the figure Store quoted and the requester confirmed, tax included.
     Recomputing it from `amount + taxAmount` would silently disagree with it
     wherever a line carries a rounded total. */
  if (usable(line.lineTotal)) {
    const n = Number(line.lineTotal);
    if (n < 0) return fail("NEGATIVE_LINE_AMOUNT", `${at} has a negative total.`, { index });
    return { ok: true, paise: toPaise(n), basis: "lineTotal" };
  }

  /* Older lines carry no `lineTotal`. `amount` is the net and `taxAmount` the
     tax on it; a line with neither has no figure at all, which is different
     from a line that costs nothing. */
  if (!usable(line.amount)) {
    /* A non-finite value that was PRESENT is a fault, not an absence — NaN
       arriving from a bad parse must not read as "this line is free". */
    if (line.amount !== null && line.amount !== undefined) {
      return fail("INVALID_LINE_AMOUNT", `${at} has an amount that is not a number.`, { index });
    }
    return fail("MISSING_LINE_AMOUNT", `${at} has no approved amount.`, { index });
  }

  const net = Number(line.amount);
  if (net < 0) return fail("NEGATIVE_LINE_AMOUNT", `${at} has a negative amount.`, { index });

  let tax = 0;
  if (line.taxAmount !== null && line.taxAmount !== undefined) {
    if (!usable(line.taxAmount)) {
      return fail("INVALID_LINE_AMOUNT", `${at} has a tax amount that is not a number.`, { index });
    }
    tax = Number(line.taxAmount);
    if (tax < 0) return fail("NEGATIVE_LINE_AMOUNT", `${at} has a negative tax amount.`, { index });
  }

  return { ok: true, paise: toPaise(net) + toPaise(tax), basis: "amount+tax" };
}

/**
 * Split an approved grand total across lines.
 *
 * @param {object[]} lines    request lines, in document order
 * @param {number}   grandTotal  what finance approved for the whole request
 * @returns {{ok:true, allocations:[], totals:{}}|{ok:false, code, message}}
 */
function allocateLines({ lines = [], grandTotal } = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    return fail("NO_LINES", "This request has no lines to allocate.");
  }

  const base = [];
  for (const [index, line] of lines.entries()) {
    const got = lineAmountOf(line, index);
    if (!got.ok) return got;
    base.push({ index, line, paise: got.paise, basis: got.basis });
  }

  const linesPaise = base.reduce((t, b) => t + b.paise, 0);

  /* An approved total that is absent falls back to what the lines say. Old
     requests carry no `grandTotal`, and inventing a difference for them would
     manufacture an adjustment nobody applied. */
  const approvedPaise = usable(grandTotal) ? toPaise(Number(grandTotal)) : linesPaise;
  if (approvedPaise < 0) {
    return fail("NEGATIVE_TOTAL", "The approved total is negative.");
  }

  const differencePaise = approvedPaise - linesPaise;

  /* ── WHERE AN ADJUSTMENT CAN AND CANNOT GO ────────────────────────────────
     Proportional means proportional to something. When every line is zero
     there is no proportion to use, so a non-zero difference cannot be placed
     honestly and the approval is refused rather than dropped on an arbitrary
     line. */
  const eligible = base.filter((b) => b.paise > 0);
  if (differencePaise !== 0 && !eligible.length) {
    return fail(
      "ADJUSTMENT_NOT_ALLOCATABLE",
      `The approved total differs from the sum of the lines by ${toRupees(Math.abs(differencePaise))}, `
      + "and every line is zero, so there is no proportion to spread it across.",
      { differenceAmount: toRupees(differencePaise) },
    );
  }

  /* A reduction cannot take a line below zero — that would be a "negative
     commitment" on a head, which is not a thing anybody can act on. */
  if (differencePaise < 0 && Math.abs(differencePaise) > linesPaise) {
    return fail(
      "ADJUSTMENT_NOT_ALLOCATABLE",
      "The approved total is less than zero once the header adjustment is applied to the lines.",
      { differenceAmount: toRupees(differencePaise) },
    );
  }

  const eligiblePaise = eligible.reduce((t, b) => t + b.paise, 0);
  const adjustment = new Map();
  let placed = 0;

  /* Every eligible line but the LAST takes its proportional share, rounded to
     the paise. */
  for (const b of eligible.slice(0, -1)) {
    const share = Math.round((differencePaise * b.paise) / eligiblePaise);
    adjustment.set(b.index, share);
    placed += share;
  }
  /* ── THE REMAINDER, NOT AN ACCUMULATED ERROR ────────────────────────────
     Computed as "everything not yet placed", so the parts add to the whole by
     construction rather than by luck. Deterministic: the same lines in the
     same order always produce the same split. */
  if (eligible.length) {
    const last = eligible[eligible.length - 1];
    adjustment.set(last.index, differencePaise - placed);
  }

  const allocations = base.map((b) => {
    const adj = adjustment.get(b.index) || 0;
    return {
      index: b.index,
      spendLineId: b.line._id ? String(b.line._id) : null,
      name: b.line.name || "",
      /* The line's own figure, before the header adjustment — kept so a
         reader can see what changed and by how much. */
      lineAmount: toRupees(b.paise),
      amountBasis: b.basis,
      /* Surfaced per line, never folded silently into the committed figure. */
      adjustment: toRupees(adj),
      adjustmentEligible: b.paise > 0,
      amount: toRupees(b.paise + adj),
    };
  });

  const allocatedPaise = allocations.reduce((t, a) => t + toPaise(a.amount), 0);
  /* The invariant, asserted rather than assumed. If this ever fails the bug is
     here, and saying so beats committing a total nobody can reconcile. */
  if (allocatedPaise !== approvedPaise) {
    return fail(
      "ALLOCATION_DOES_NOT_BALANCE",
      `Allocated ${toRupees(allocatedPaise)} against an approved total of ${toRupees(approvedPaise)}.`,
      { allocated: toRupees(allocatedPaise), approved: toRupees(approvedPaise) },
    );
  }

  return {
    ok: true,
    allocations,
    totals: {
      lines: toRupees(linesPaise),
      approved: toRupees(approvedPaise),
      adjustment: toRupees(differencePaise),
      allocated: toRupees(allocatedPaise),
    },
  };
}

/**
 * Group allocations by the budget line they consume.
 *
 * ── WHY GROUPING IS THE WHOLE POINT ─────────────────────────────────────────
 * Two lines charged to the same head are ONE claim on that head's headroom.
 * Checking them separately lets each see the same starting availability and
 * each conclude it fits — so ₹6,000 and ₹5,000 both pass against ₹10,000 and
 * the head goes ₹1,000 over with two approvals that were each individually
 * correct.
 *
 * `heads` is keyed by `budgetLineId`. Unbudgeted allocations have no line to
 * group under and are returned separately: they are still promises the company
 * has made, and finance needs their total, but they reduce nothing.
 */
function groupByBudgetLine(allocations = []) {
  const heads = new Map();
  const unbudgeted = [];

  for (const a of allocations) {
    if (!a.budgetLineId) { unbudgeted.push(a); continue; }
    const key = String(a.budgetLineId);
    const g = heads.get(key) || {
      budgetLineId: key,
      budgetId: a.budgetId || null,
      ledgerId: a.ledgerId || null,
      ledgerName: a.ledgerName || "",
      financialYear: a.financialYear || null,
      lines: [],
      amountPaise: 0,
    };
    g.lines.push(a);
    g.amountPaise += toPaise(a.amount);
    heads.set(key, g);
  }

  return {
    heads: [...heads.values()].map((g) => ({
      budgetLineId: g.budgetLineId,
      budgetId: g.budgetId,
      ledgerId: g.ledgerId,
      ledgerName: g.ledgerName,
      financialYear: g.financialYear,
      spendLineIds: g.lines.map((l) => l.spendLineId),
      lineCount: g.lines.length,
      amount: toRupees(g.amountPaise),
    })),
    unbudgeted: {
      spendLineIds: unbudgeted.map((l) => l.spendLineId),
      lineCount: unbudgeted.length,
      amount: toRupees(unbudgeted.reduce((t, l) => t + toPaise(l.amount), 0)),
    },
  };
}

/**
 * Does each GROUP fit its head?
 *
 * `availability` is keyed by `budgetLineId` and carries the figures the head
 * already has: `{ approved, committed, actual, available }`. The check is on
 * the grouped amount, once, against the availability that existed before this
 * request — never per line against a figure each line reads independently.
 */
function checkGroups({ groups = [], availability = new Map() } = {}) {
  return groups.map((g) => {
    const have = availability.get(String(g.budgetLineId)) || null;
    if (!have) {
      return {
        ...g,
        known: false,
        status: "unknown_head",
        message: "No approved budget line was found for this head.",
      };
    }
    const availableBefore = Number(have.available) || 0;
    const availableAfter = Math.round((availableBefore - g.amount) * 100) / 100;
    return {
      ...g,
      known: true,
      approved: Number(have.approved) || 0,
      committedBefore: Number(have.committed) || 0,
      actual: Number(have.actual) || 0,
      availableBefore,
      availableAfter,
      /* The shortage, stated. "Insufficient" alone makes somebody do the
         subtraction, and the figure is the thing they need. */
      shortfall: availableAfter < 0 ? Math.abs(availableAfter) : 0,
      status: availableAfter < 0 ? "insufficient" : "within_budget",
    };
  });
}

module.exports = {
  lineAmountOf,
  allocateLines,
  groupByBudgetLine,
  checkGroups,
  toPaise,
  toRupees,
};
