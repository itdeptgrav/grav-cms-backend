/**
 * GRAV-CMS-BACKEND/services/budgetActionCentre.service.js
 *
 * What a department head needs to know when they open /budget.
 *
 * ── WHY THIS IS DERIVED AND NOT STORED ──────────────────────────────────────
 * Every alert here is a restatement of something already true elsewhere: a
 * request is countered, a line is past its plan, a cycle closes on Friday.
 * Storing them would create a second copy of each fact that can go stale
 * against the first — an alert saying "finance countered this" after the
 * department already answered is worse than no alert at all. So they are
 * computed on read from the same rows every other screen reads.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * Not a finance dashboard. Everything it receives has already been narrowed
 * to the caller's own budget departments by the route; nothing here widens
 * that, and no company-wide figure is computed. If a department has no
 * revenue heads it gets no revenue alerts — not a zero.
 *
 * Pure: give it rows, get groups. The route does the fetching and the scoping.
 */

/** A cycle closing inside this many days is a deadline, not a reminder. */
const CLOSING_SOON_DAYS = 14;

/** Severities the UI understands, worst first. */
const SEVERITY = { risk: 3, warning: 2, info: 1, positive: 0 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A rupee figure inside a sentence.
 *
 * Descriptions are prose the UI prints verbatim, so the numbers in them have
 * to arrive readable — "Spent 1310000 against an approved 1180000" is a
 * sentence nobody parses at a glance. Structured `amount` is still returned
 * separately for the UI to render its own way; this is only for the words.
 */
function money(v) {
  return `₹ ${num(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Whole days from now until `date`, or null when it cannot be read. */
function daysUntil(date, now) {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / 86400000);
}

const proposeHref = (budgetId, requestId) =>
  `/budget/cycles/${budgetId}/propose${requestId ? `?request=${requestId}` : ""}`;

/**
 * Build the five groups.
 *
 * `tracker` is the already-computed department tracker — its heads carry the
 * severity budgetVariance decided, so risk is not re-derived here with a
 * second set of thresholds that could disagree with the tables below.
 */
function buildActionCentre({
  cycles = [],
  requests = [],
  adjustments = [],
  transfers = [],
  tracker = null,
  now = new Date(),
} = {}) {
  const needsYourAnswer = [];
  const waitingOnFinance = [];
  const financeUpdates = [];
  const financialRisks = [];
  const deadlines = [];

  const byCycle = new Map();
  for (const r of requests) {
    const k = String(r.budgetId);
    if (!byCycle.has(k)) byCycle.set(k, []);
    byCycle.get(k).push(r);
  }

  /* ── 1 · NEEDS YOUR ANSWER ─────────────────────────────────────────────
     Only things that cannot move without this department. */
  for (const r of requests) {
    if (r.state === "countered") {
      needsYourAnswer.push({
        id: `counter-${r._id}`,
        type: "proposal_countered",
        severity: "warning",
        title: `${r.ledgerName || "A line"} — finance countered`,
        description:
          r.counterAmount != null
            ? `They offered ${money(r.counterAmount)} against your ${money(r.requestedAmount)}.`
            : r.financeNote || "Finance has proposed a different figure.",
        amount: r.counterAmount ?? null,
        budgetId: String(r.budgetId),
        requestId: String(r._id),
        actionLabel: "Respond",
        actionHref: proposeHref(r.budgetId, r._id),
        at: r.updatedAt || r.submittedAt || null,
      });
    }

    if (r.state === "awaiting") {
      needsYourAnswer.push({
        id: `awaiting-${r._id}`,
        type: "proposal_awaiting",
        severity: "warning",
        title: `${r.ledgerName || "A line"} — finance is waiting for your figure`,
        description: "An envelope was opened for this head and no amount has been put in it.",
        amount: null,
        budgetId: String(r.budgetId),
        requestId: String(r._id),
        actionLabel: "Add figure",
        actionHref: proposeHref(r.budgetId, r._id),
        at: r.updatedAt || r.submittedAt || null,
      });
    }

    /* A head finance has questioned or refused blocks the whole line, and
       only the department can move it. */
    const hs = r.requestedHead?.state;
    if (hs === "clarification" || hs === "rejected") {
      needsYourAnswer.push({
        id: `head-${r._id}`,
        type: hs === "rejected" ? "head_rejected" : "head_clarification",
        severity: hs === "rejected" ? "risk" : "warning",
        title:
          hs === "rejected"
            ? `${r.requestedHead.name} — finance refused this budget head`
            : `${r.requestedHead.name} — finance has a question about this head`,
        description: r.requestedHead.financeNote || "Nothing can be approved on this line until it is settled.",
        amount: null,
        budgetId: String(r.budgetId),
        requestId: String(r._id),
        actionLabel: "Revise",
        actionHref: proposeHref(r.budgetId, r._id),
        at: r.requestedHead.resolvedAt || null,
      });
    }
  }

  /* ── 2 · WAITING ON FINANCE ────────────────────────────────────────────
     Calm by construction: nothing here needs the department to do anything,
     and dressing it as urgent would teach people to ignore group 1. */
  const submitted = requests.filter((r) => r.state === "submitted");
  if (submitted.length) {
    waitingOnFinance.push({
      id: "pending-proposals",
      type: "proposals_pending",
      severity: "info",
      title: `${submitted.length} proposed line${submitted.length === 1 ? "" : "s"} with finance`,
      description: "Sent and unanswered. Nothing is needed from you.",
      amount: submitted.reduce((s, r) => s + num(r.requestedAmount), 0),
      budgetId: submitted[0] ? String(submitted[0].budgetId) : null,
      requestId: null,
      actionLabel: "See the record",
      actionHref: "/budget",
      at: submitted[0]?.submittedAt || null,
    });
  }

  const headsPending = requests.filter((r) => r.requestedHead?.state === "requested");
  if (headsPending.length) {
    waitingOnFinance.push({
      id: "pending-heads",
      type: "heads_pending",
      severity: "info",
      title: `${headsPending.length} new budget head${headsPending.length === 1 ? "" : "s"} awaiting finance`,
      description:
        "Finance has to map these to the chart of accounts before the lines can be approved.",
      amount: null,
      budgetId: String(headsPending[0].budgetId),
      requestId: String(headsPending[0]._id),
      actionLabel: "See the record",
      actionHref: "/budget",
      at: headsPending[0].requestedHead?.requestedAt || null,
    });
  }

  const openAdj = adjustments.filter((a) => a.state === "submitted" || a.state === "reviewed");
  for (const a of openAdj) {
    waitingOnFinance.push({
      id: `adj-${a._id}`,
      type: "adjustment_pending",
      severity: "info",
      title: `${a.ledgerName || "A line"} — change request with finance`,
      description:
        a.type === "supplementary"
          ? `Asking for ${money(a.requestedDeltaAmount)} more, taking it to ${money(a.requestedNewAmount)}.`
          : `Asking to revise it to ${money(a.requestedNewAmount)}.`,
      amount: a.requestedNewAmount ?? null,
      budgetId: String(a.budgetId),
      adjustmentId: String(a._id),
      actionLabel: "See change requests",
      actionHref: "/budget",
      at: a.requestedAt || null,
    });
  }

  const openTransfers = transfers.filter((t) => t.state === "submitted" || t.state === "reviewed");
  for (const t of openTransfers) {
    waitingOnFinance.push({
      id: `tr-${t._id}`,
      type: "transfer_pending",
      severity: "info",
      title: "A transfer touching your budget is with finance",
      description: `${t.fromLedgerName || "one line"} → ${t.toLedgerName || "another"}.`,
      amount: t.amount ?? null,
      budgetId: String(t.budgetId),
      transferId: String(t._id),
      actionLabel: "See my budget",
      actionHref: "/budget",
      at: t.requestedAt || null,
    });
  }

  /* ── 3 · WHAT FINANCE DECIDED ──────────────────────────────────────────
     Status, not alarm — including the refusals, which belong here because
     nothing remains to be done about them. */
  const agreed = requests.filter((r) => r.state === "agreed");
  if (agreed.length) {
    financeUpdates.push({
      id: "agreed-proposals",
      type: "proposals_agreed",
      severity: "positive",
      title: `${agreed.length} line${agreed.length === 1 ? "" : "s"} approved`,
      description: "These are in your approved budget below.",
      amount: agreed.reduce((s, r) => s + num(r.agreedAmount ?? r.requestedAmount), 0),
      budgetId: String(agreed[0].budgetId),
      requestId: null,
      actionLabel: "See approved budget",
      actionHref: "/budget",
      at: agreed[0].updatedAt || null,
    });
  }

  for (const r of requests) {
    if (r.state !== "defaulted") continue;
    financeUpdates.push({
      id: `defaulted-${r._id}`,
      type: "proposal_defaulted",
      severity: "info",
      title: `${r.ledgerName || "A line"} — closed without funding`,
      description: r.financeNote || "The cycle closed before this was agreed.",
      amount: r.requestedAmount ?? null,
      budgetId: String(r.budgetId),
      requestId: String(r._id),
      actionLabel: "See the record",
      actionHref: "/budget",
      at: r.updatedAt || null,
    });
  }

  for (const a of adjustments) {
    if (a.state !== "approved" && a.state !== "rejected") continue;
    financeUpdates.push({
      id: `adjdone-${a._id}`,
      type: a.state === "approved" ? "adjustment_approved" : "adjustment_rejected",
      severity: a.state === "approved" ? "positive" : "info",
      title: `${a.ledgerName || "A line"} — change ${a.state === "approved" ? "approved" : "refused"}`,
      description:
        a.state === "approved"
          ? `Now ${money(a.approvedNewAmount ?? a.requestedNewAmount)}.`
          : a.financeNote || "Finance refused the change.",
      amount: (a.state === "approved" ? a.approvedNewAmount : a.requestedNewAmount) ?? null,
      budgetId: String(a.budgetId),
      adjustmentId: String(a._id),
      actionLabel: "See change requests",
      actionHref: "/budget",
      at: a.reviewedAt || a.requestedAt || null,
    });
  }

  for (const r of requests) {
    const hs = r.requestedHead?.state;
    if (hs !== "mapped" && hs !== "created") continue;
    financeUpdates.push({
      id: `headdone-${r._id}`,
      type: "head_resolved",
      severity: "positive",
      title: `${r.requestedHead.name} → ${r.requestedHead.resolvedLedgerName || "mapped"}`,
      description:
        r.requestedHead.financeNote ||
        (hs === "created"
          ? "Finance created this head for you."
          : "Finance mapped it onto an existing head."),
      amount: null,
      budgetId: String(r.budgetId),
      requestId: String(r._id),
      actionLabel: "See the record",
      actionHref: "/budget",
      at: r.requestedHead.resolvedAt || null,
    });
  }

  /* ── 4 · FINANCIAL RISK ────────────────────────────────────────────────
     Read off the tracker's own severity, which budgetVariance decided. A
     second set of thresholds here would eventually disagree with the tables
     below it, and the reader would have no way to tell which was right.

     Nothing is emitted for a nature the department does not have — a
     department with no revenue heads gets no revenue alert, not a zero. */
  for (const h of tracker?.heads || []) {
    if (h.unbound) continue;
    const isRevenue = h.nature === "revenue";

    if (!isRevenue) {
      const over = h.remaining !== null && h.remaining < 0;
      if (over) {
        financialRisks.push({
          id: `over-${h.key || h.ledgerId}`,
          type: "expense_over_budget",
          severity: "risk",
          title: `${h.ledgerName} is over budget`,
          description: `Spent ${money(h.actual)} against an approved ${money(h.approved)}.`,
          amount: Math.abs(h.remaining),
          budgetId: h.budgetId || null,
          ledgerId: h.ledgerId || null,
          actionLabel: "Open the head",
          actionHref: h.ledgerId ? `/budget/heads/${h.ledgerId}?nature=expense` : "/budget",
          at: tracker?.asOf || null,
        });
      } else if (h.severity === "critical" || h.severity === "warning") {
        financialRisks.push({
          id: `near-${h.key || h.ledgerId}`,
          type: "expense_near_limit",
          severity: h.severity === "critical" ? "risk" : "warning",
          title: `${h.ledgerName} is close to its budget`,
          description:
            h.utilizationPct !== null
              ? `${Math.round(h.utilizationPct)}% used${h.paceGap !== null && h.paceGap < 0 ? ", ahead of plan" : ""}.`
              : "Spending is running ahead of plan.",
          amount: h.remaining === null ? null : Math.max(0, h.remaining),
          budgetId: h.budgetId || null,
          ledgerId: h.ledgerId || null,
          actionLabel: "Open the head",
          actionHref: h.ledgerId ? `/budget/heads/${h.ledgerId}?nature=expense` : "/budget",
          at: tracker?.asOf || null,
        });
      }
      continue;
    }

    /* Revenue is never "over budget". Beating a target is not a risk, so only
       a shortfall against where the plan says it should be by now counts —
       and `paceGap` is already that comparison. */
    if (h.paceGap !== null && h.paceGap < 0 && (h.severity === "critical" || h.severity === "warning")) {
      financialRisks.push({
        id: `behind-${h.key || h.ledgerId}`,
        type: "revenue_behind_target",
        severity: h.severity === "critical" ? "risk" : "warning",
        title: `${h.ledgerName} is behind target`,
        description: `Earned ${money(h.actual)} of ${money(h.approved)}; the plan expected ${money(h.expectedToDate)} by now.`,
        amount: Math.abs(h.paceGap),
        budgetId: h.budgetId || null,
        ledgerId: h.ledgerId || null,
        actionLabel: "Open the head",
        actionHref: h.ledgerId ? `/budget/heads/${h.ledgerId}?nature=revenue` : "/budget",
        at: tracker?.asOf || null,
      });
    }
  }

  /* ── 4b · THE NET, BUT ONLY WHEN IT MEANS SOMETHING ────────────────────
     Contribution — what the department earns less what it spends — is the one
     figure allowed to span both natures, because it SUBTRACTS. It is emitted
     only when the department actually has both sides and the tracker computed
     an expectation for each; a "net" over one nature is that nature wearing a
     grander name, and a net against a year-end target says nothing in month
     two.

     Compared to where the PLAN says the net should be by now, not to the
     year-end number — the same pace logic every per-head risk uses. */
  const tot = tracker?.totals;
  if (tot?.hasRevenue && tot?.hasExpense) {
    const expectedNet = num(tot.revenue.expectedToDate) - num(tot.expense.expectedToDate);
    const actualNet = num(tot.revenue.actual) - num(tot.expense.actual);
    const shortfall = expectedNet - actualNet;

    /* Only a shortfall, and only one worth reading: a net ahead of plan is
       not a risk, and a rounding-sized gap is noise. One percent of the
       expected revenue is the floor — a scale the department recognises. */
    const floor = Math.max(1, num(tot.revenue.expectedToDate) * 0.01);
    if (expectedNet !== 0 && shortfall > floor) {
      financialRisks.push({
        id: "net-behind",
        type: "net_behind_plan",
        severity: "warning",
        title: "Net contribution is behind plan",
        description: `Earning less spending comes to ${money(actualNet)}; the plan expected ${money(expectedNet)} by now.`,
        amount: shortfall,
        budgetId: null,
        ledgerId: null,
        actionLabel: "See approved budget",
        actionHref: "/budget",
        at: tracker?.asOf || null,
      });
    }
  }

  /* ── 5 · DEADLINES ─────────────────────────────────────────────────────
     A round closing with nothing in it is the one case where silence costs
     the department its whole ask. */
  for (const c of cycles) {
    const days = daysUntil(c.endDate, now);
    if (days === null || days < 0 || days > CLOSING_SOON_DAYS) continue;

    const mine = byCycle.get(String(c._id)) || [];
    const unanswered = mine.filter((r) => r.state === "countered" || r.state === "awaiting");

    if (!mine.length) {
      deadlines.push({
        id: `close-empty-${c._id}`,
        type: "cycle_closing_empty",
        severity: "risk",
        title: `${c.name} closes in ${days} day${days === 1 ? "" : "s"} — nothing submitted`,
        description: "Nothing has been proposed into this cycle from your department.",
        amount: null,
        budgetId: String(c._id),
        actionLabel: "Start a proposal",
        actionHref: proposeHref(c._id),
        at: c.endDate,
      });
    } else if (unanswered.length) {
      deadlines.push({
        id: `close-open-${c._id}`,
        type: "cycle_closing_incomplete",
        severity: "warning",
        title: `${c.name} closes in ${days} day${days === 1 ? "" : "s"}`,
        description: `${unanswered.length} line${unanswered.length === 1 ? "" : "s"} still need${unanswered.length === 1 ? "s" : ""} your answer before it closes.`,
        amount: null,
        budgetId: String(c._id),
        requestId: String(unanswered[0]._id),
        actionLabel: "Respond",
        actionHref: proposeHref(c._id, unanswered[0]._id),
        at: c.endDate,
      });
    }
  }

  const worstFirst = (a, b) =>
    (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) ||
    new Date(b.at || 0) - new Date(a.at || 0);

  needsYourAnswer.sort(worstFirst);
  financialRisks.sort(worstFirst);
  deadlines.sort(worstFirst);
  /* The two calm groups read newest-first: they are a log, not a queue. */
  const newestFirst = (a, b) => new Date(b.at || 0) - new Date(a.at || 0);
  waitingOnFinance.sort(newestFirst);
  financeUpdates.sort(newestFirst);

  return {
    needsYourAnswer,
    waitingOnFinance,
    financeUpdates,
    financialRisks,
    deadlines,
    counts: {
      needsYourAnswer: needsYourAnswer.length,
      waitingOnFinance: waitingOnFinance.length,
      financeUpdates: financeUpdates.length,
      financialRisks: financialRisks.length,
      deadlines: deadlines.length,
      /* What the department must act on: the two groups that block work. */
      actionable: needsYourAnswer.length + deadlines.length,
    },
  };
}

module.exports = { CLOSING_SOON_DAYS, buildActionCentre, daysUntil };
