/**
 * services/budgetRequestContext.service.js
 *
 * WHAT FINANCE NEEDS TO KNOW BEFORE AGREEING A DEPARTMENT'S ASK.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * The submissions queue showed a department, a head, an amount and a state.
 * None of that answers the only question finance is actually being asked:
 * given what this head has already been given, already spent and already
 * promised, is agreeing this figure safe?
 *
 * So this composes, per request, the same three figures the rest of the budget
 * module speaks in — approved, actual, committed — and what they become if the
 * request is agreed.
 *
 * ── WHAT AGREEING ACTUALLY DOES, AND WHY THE ARITHMETIC LOOKS BACKWARDS ─────
 * A budget request is NOT a request to spend. It is a request to be ALLOCATED
 * money, and agreeing it writes an allocation line into the cycle (see
 * `syncAllocationFromRequest` in Acc_budgets.js). So the envelope goes UP, and
 * "available after approval" is larger than "available before".
 *
 * That is not a rounding of the truth, it is the truth: the risk on this desk
 * is not that agreeing overspends a head, it is that a head has ALREADY been
 * spent past what the new allocation would cover. `availableAfter < 0` is
 * exactly that case and is the thing worth shouting about.
 *
 * Agreeing a request that was agreed before UPDATES its own line rather than
 * adding a second one, so that line is excluded from "approved before" — or
 * re-agreeing 3L as 4L would read as 7L.
 *
 * ── A REVENUE TARGET IS NOT AN ENVELOPE ─────────────────────────────────────
 * The module's oldest rule, and it holds here. A revenue head has a target to
 * reach, not a budget to spend out of: there is no "available", nothing can be
 * "over budget", and the words are target / earned / to go / achieved. Mixing
 * the two vocabularies is how a sales target ends up reported as an overspend.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 * Decide anything. It computes no new arithmetic of its own: actuals come from
 * budgetActuals, commitments from budgetCommitment, nature from the ledger
 * tree via budgetVariance — the same sources every other budget figure in this
 * module already uses. Nothing here writes, and no approval rule consults it.
 */

"use strict";

const actuals = require("./budgetActuals.service");
const variance = require("./budgetVariance.service");
const commitments = require("./budgetCommitment.service");
const departments = require("./budgetDepartment.service");
const phasing = require("./budgetPhasing.service");

const money = variance.money;

/** A percentage, or null when the denominator makes one meaningless. */
function pct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return null;
  return Math.round((Number(part) / w) * 1000) / 10;
}

/* ── THE VERDICTS ────────────────────────────────────────────────────────────
 * Five, and deliberately not one scale. "Will exceed budget" and "Revenue
 * target change" are not two points on the same line — one is a problem and
 * the other is a kind of request — and forcing them into a single severity
 * ramp is how a sales target starts rendering in the same red as an overspend.
 *
 * `rank` orders the queue and picks the summary's biggest risk. It is a
 * display order, never an approval rule. */
const VERDICT = Object.freeze({
  NO_HEAD: { id: "no_head", label: "No approved budget head", rank: 3 },
  UNKNOWN_NATURE: { id: "unknown_nature", label: "Head nature not classified", rank: 2 },
  EXCEEDS: { id: "exceeds", label: "Will exceed budget", rank: 4 },
  NET_RISK: { id: "net_risk", label: "Net impact risk", rank: 1 },
  REVENUE: { id: "revenue_target", label: "Revenue target change", rank: 0 },
  WITHIN: { id: "within", label: "Within budget", rank: 0 },
});

/**
 * How a head's target moves.
 *
 * Compares the target BEFORE against the target AFTER — deliberately not the
 * ask against the standing target, which is a different comparison that gives
 * a different answer. Agreeing writes a new allocation line rather than
 * replacing the old one (see `syncAllocationFromRequest`), so a ₹3L ask on a
 * head already carrying ₹20L RAISES it to ₹23L. Comparing 3 against 20 would
 * have labelled that "reduced" and printed the word next to a target going up.
 *
 * Through this door the answer is therefore only ever "new" or "increased" —
 * the schema floors a request at zero, so nothing here can lower a target. The
 * other two answers are kept because the comparison itself is general and the
 * adjustments desk does lower them.
 */
function targetDirection(before, after) {
  const b = money(before) || 0;
  const a = money(after) || 0;
  if (b <= 0) return "new";
  if (a > b) return "increased";
  if (a < b) return "reduced";
  return "unchanged";
}

/**
 * The figure this request would actually be agreed at.
 *
 * Finance's counter wins over the ask once there is one — a countered request
 * is finance saying "not that, this", and showing the department's original
 * figure against the envelope would be modelling a decision nobody is going to
 * make. An agreed request reports what was agreed.
 */
function decidingAmount(r) {
  if (r.state === "agreed" && r.agreedAmount != null) return money(r.agreedAmount) || 0;
  if (r.state === "countered" && r.counterAmount != null) return money(r.counterAmount) || 0;
  return money(r.requestedAmount) || 0;
}

/**
 * Budget context for every request on a cycle.
 *
 * @param {object} budget a lean Acc_Budget document
 * @param {Array}  requests the subset being shown (defaults to all of them)
 * @returns {Promise<{contexts: object, summary: object}>} contexts keyed by
 *          request id, so the caller can attach without re-ordering anything
 */
async function contextFor({ budget, requests = null, companyId = null }) {
  const rows = requests || budget?.budgetRequests || [];
  const empty = { contexts: {}, summary: emptySummary() };
  if (!budget || !rows.length) return empty;

  const cid = actuals.oid(companyId || budget.companyId);
  const items = budget.items || [];

  /* ── WHAT EACH REQUEST'S HEAD ALREADY HOLDS ─────────────────────────────
     Matched on ledger AND department, the same pairing every other figure in
     this module scopes by: one ledger can be budgeted for four departments,
     and a Tech ask read against Merchandising's line would be answered with
     somebody else's money. */
  const allocationsFor = (r) => {
    if (!r.ledgerId) return [];
    const wanted = departments.slugify(r.department);
    return items.filter(
      (it) =>
        it.ledgerId &&
        String(it.ledgerId) === String(r.ledgerId) &&
        departments.slugify(it.department) === wanted &&
        /* This request's OWN line, if it has already been agreed once. Counted
           as approved-before it would double the money on a re-agreement. */
        !(it.sourceRequestId && String(it.sourceRequestId) === String(r._id)),
    );
  };

  /* One hydrate for the whole page: a queue of forty requests must not be
     forty aggregations. Head-level, because a budget request carries no cost
     centre — see `costCentreBound` below for what that costs. */
  const hydrated = await actuals
    .hydrateLines({
      companyId: cid,
      lines: rows.map((r) => ({
        ledgerId: r.ledgerId || null,
        costCentreId: null,
        nature: r.nature,
        ledgerName: r.ledgerName,
      })),
      from: budget.startDate,
      to: budget.endDate,
    })
    .catch(() => rows.map(() => null));

  /* And one commitment read, over every allocation line any of them touches. */
  const lineIds = [...new Set(rows.flatMap((r) => allocationsFor(r).map((it) => String(it._id))))];
  const committedByLine = lineIds.length
    ? await commitments.committedByLine(lineIds).catch(() => new Map())
    : new Map();

  const contexts = {};
  for (const [i, r] of rows.entries()) {
    contexts[String(r._id)] = buildOne({
      request: r,
      hydratedLine: hydrated[i],
      allocations: allocationsFor(r),
      committedByLine,
    });
  }

  const summary = summarise(rows, contexts, budget);

  /* The shape of the year the desk is deciding against. Computed after the
     summary because it needs to know which requests are still waiting. */
  try {
    const pending = rows
      .filter((r) => !["agreed", "rejected", "withdrawn"].includes(r.state))
      .map((r) => ({ request: r, ctx: contexts[String(r._id)] }));
    summary.monthly = await monthlyFor({ budget, pending, companyId: cid });
    Object.assign(summary, readSeries(summary.monthly));
  } catch (e) {
    /* The queue is this endpoint's job; the chart is an aid. */
    console.error("[budget] monthly series failed, returning the desk without it:", e.message);
  }

  return { contexts, summary };
}

/** One request's context. Pure — every figure it needs is already in hand. */
function buildOne({ request: r, hydratedLine, allocations, committedByLine }) {
  const asked = decidingAmount(r);

  /* ── A HEAD THAT IS NOT A LEDGER YET ────────────────────────────────────
     There is nothing to read the numbers off, and inventing zeroes would
     render as "no budget used" rather than "nobody has decided what this
     posts against". The state is the answer. */
  const unresolvedHead =
    !r.ledgerId ||
    (r.requestedHead &&
      ["requested", "clarification", "rejected"].includes(r.requestedHead.state));

  const nature = variance.natureOf({ nature: hydratedLine?.nature || r.nature });

  const approved = allocations.reduce((s, it) => s + (money(it.allocatedAmount) || 0), 0);
  const actual = money(hydratedLine?.actual) || 0;
  const committed = allocations.reduce(
    (s, it) => s + (committedByLine.get(String(it._id)) || 0),
    0,
  );
  /* An allocation bound to a cost centre counts toward the envelope, but the
     actual beside it is the whole head's. Flagged rather than silently mixed,
     because a figure that is broader than the line it sits against is a figure
     somebody should be told about. */
  const costCentreBound = allocations.some((it) => it.costCentreId);

  const base = {
    requestId: String(r._id),
    department: r.department || "",
    ledgerName: r.ledgerName || null,
    nature,
    /* Which figure the context was computed against — the ask, finance's
       counter, or what was agreed. Named so a screen never has to guess why
       the number differs from `requestedAmount`. */
    amount: asked,
    amountBasis:
      r.state === "agreed" ? "agreed" : r.state === "countered" ? "countered" : "requested",
    allocationLines: allocations.length,
    costCentreBound,
    hasHead: !unresolvedHead,
  };

  if (unresolvedHead) {
    return { ...base, kind: "no_head", verdict: VERDICT.NO_HEAD.id, verdictLabel: VERDICT.NO_HEAD.label };
  }

  /* ── AN ASSET, LIABILITY OR EQUITY HEAD ─────────────────────────────────
     `natureOf` maps those to "other" rather than coercing them to expense.
     Neither vocabulary fits, so neither is used: the screen says the nature is
     not classified and offers no misleading label. */
  if (nature !== "expense" && nature !== "revenue") {
    return {
      ...base,
      kind: "unknown",
      approved,
      actual,
      committed,
      verdict: VERDICT.UNKNOWN_NATURE.id,
      verdictLabel: VERDICT.UNKNOWN_NATURE.label,
    };
  }

  if (nature === "revenue") {
    /* Target, earned, to go, achieved. Not one word of spend. */
    const targetAfter = approved + asked;
    const earned = actual;
    return {
      ...base,
      kind: "revenue",
      target: approved,
      targetAfter,
      earned,
      toGo: Math.max(0, targetAfter - earned),
      achievedPct: pct(earned, targetAfter),
      direction: targetDirection(approved, targetAfter),
      verdict: VERDICT.REVENUE.id,
      verdictLabel: VERDICT.REVENUE.label,
    };
  }

  const availableBefore = approved - actual - committed;
  const approvedAfter = approved + asked;
  const availableAfter = approvedAfter - actual - committed;

  return {
    ...base,
    kind: "expense",
    approved,
    actual,
    committed,
    availableBefore,
    approvedAfter,
    availableAfter,
    /* Of the envelope this request would create, how much is already gone.
       Over 100 is possible and is the point of showing it. */
    usageAfterPct: pct(actual + committed, approvedAfter),
    verdict: availableAfter < 0 ? VERDICT.EXCEEDS.id : VERDICT.WITHIN.id,
    verdictLabel: availableAfter < 0 ? VERDICT.EXCEEDS.label : VERDICT.WITHIN.label,
  };
}

/* ── THE YEAR, MONTH BY MONTH ────────────────────────────────────────────────
 * The question "is the net enough" has no answer at the year level. A cycle
 * that lands ₹18L in surplus can still run out of money in August, and a
 * yearly figure says nothing about that — which is exactly the kind of number
 * a finance desk is otherwise forced to agree requests against.
 *
 * So the series carries four things per month, kept apart because they are
 * four different kinds of fact:
 *
 *   plannedRevenue / plannedExpense   what the cycle SAYS, spread by each
 *                                     line's own phasing — not straight-lined,
 *                                     or the curve would disagree with the
 *                                     decisions that produced it
 *   actualRevenue  / actualExpense    what MOVED, from posted vouchers
 *   pendingExpense / pendingRevenue   what the waiting requests would add,
 *                                     spread by the phasing each request asked
 *                                     for rather than dumped on month one
 *
 * Nets are computed here rather than on the screen: a chart that subtracts its
 * own bars is a chart that can disagree with the figure beside it.
 */
async function monthlyFor({ budget, pending, companyId }) {
  const items = budget.items || [];
  const months = phasing.monthsInPeriod(budget.startDate, budget.endDate);
  if (!months.length) return [];

  const bucket = new Map(
    months.map((key) => [
      key,
      {
        key,
        plannedRevenue: 0,
        plannedExpense: 0,
        actualRevenue: 0,
        actualExpense: 0,
        pendingRevenue: 0,
        pendingExpense: 0,
      },
    ]),
  );

  /* ── WHAT THE CYCLE ALREADY SAYS ───────────────────────────────────────
     Spread by each line's own phasing — the same helper the dashboard's plan
     curve uses, so the two cannot tell different stories about one year. */
  for (const it of items) {
    const alloc = money(it.allocatedAmount) || 0;
    if (!(alloc > 0)) continue;
    const nature = variance.natureOf({ nature: it.nature });
    if (nature !== "revenue" && nature !== "expense") continue;

    const spread = phasing.plannedByMonth({
      amount: alloc,
      startDate: budget.startDate,
      endDate: budget.endDate,
      phasingMode: it.phasingMode,
      monthlyPhasing: it.monthlyPhasing,
      phasing: it.phasing,
    });
    for (const [key, share] of spread) {
      const b = bucket.get(key);
      if (!b) continue;
      if (nature === "revenue") b.plannedRevenue += share;
      else b.plannedExpense += share;
    }
  }

  /* ── WHAT THE WAITING REQUESTS WOULD ADD ───────────────────────────────
     Each by the shape IT asked for. A department that phased its ask across
     three months is not asking for the money in April, and drawing it there
     would invent a cash problem nobody has. */
  for (const { request: r, ctx } of pending) {
    if (!ctx || (ctx.kind !== "expense" && ctx.kind !== "revenue" && ctx.kind !== "no_head")) continue;
    const amount = ctx.amount;
    if (!(amount > 0)) continue;

    const spread = phasing.plannedByMonth({
      amount,
      startDate: budget.startDate,
      endDate: budget.endDate,
      /* The agreed shape once there is one — finance's phasing is the decision
         that will actually be written, not the department's proposal. */
      phasingMode: r.agreedPhasingMode || r.phasingMode,
      monthlyPhasing:
        r.agreedPhasingMode === "custom_monthly" ? r.agreedMonthlyPhasing : r.monthlyPhasing,
    });
    for (const [key, share] of spread) {
      const b = bucket.get(key);
      if (!b) continue;
      /* An unresolved head is spending nobody has classified yet, and leaving
         it out would draw a kinder year than the one being decided. */
      if (ctx.kind === "revenue") b.pendingRevenue += share;
      else b.pendingExpense += share;
    }
  }

  /* ── WHAT ACTUALLY MOVED ───────────────────────────────────────────────
     One aggregation over every head the cycle touches. Read from posted
     vouchers, which is the module's only source for an actual. */
  const ledgerIds = [
    ...new Set(items.map((it) => it.ledgerId).filter(Boolean).map(String)),
  ];
  if (ledgerIds.length) {
    try {
      const [natures, rows] = await Promise.all([
        actuals.natureByLedger(ledgerIds),
        actuals.monthlyMovement({
          companyId,
          ledgerIds,
          from: budget.startDate,
          to: budget.endDate,
        }),
      ]);
      for (const row of rows || []) {
        const b = bucket.get(row.key);
        if (!b) continue;
        const meta = natures.get(String(row.ledgerId));
        const nature = variance.natureOf({ nature: meta?.nature || meta });
        const amount = actuals.actualFrom(row, nature);
        if (nature === "revenue") b.actualRevenue += amount;
        else if (nature === "expense") b.actualExpense += amount;
      }
    } catch (e) {
      /* A missing actuals read leaves the plan and the pending asks drawn, and
         the screen says the actual line is absent. Better than no chart. */
      console.error("[budget] monthly actuals failed, drawing the plan only:", e.message);
    }
  }

  return [...bucket.values()].map((b) => ({
    key: b.key,
    plannedRevenue: round(b.plannedRevenue),
    plannedExpense: round(b.plannedExpense),
    actualRevenue: round(b.actualRevenue),
    actualExpense: round(b.actualExpense),
    pendingRevenue: round(b.pendingRevenue),
    pendingExpense: round(b.pendingExpense),
    /* Three nets, because there are three questions. What the plan says, what
       has actually happened, and what the plan becomes if the desk agrees
       everything waiting on it. */
    plannedNet: round(b.plannedRevenue - b.plannedExpense),
    actualNet: round(b.actualRevenue - b.actualExpense),
    netAfterPending: round(
      b.plannedRevenue + b.pendingRevenue - b.plannedExpense - b.pendingExpense,
    ),
  }));
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const emptySummary = () => ({
  waiting: 0,
  requestedExpense: 0,
  requestedRevenue: 0,
  committedImpact: 0,
  exceeding: 0,
  unresolvedHeads: 0,
  unclassified: 0,
  plannedNet: 0,
  netAfterPending: 0,
  biggestRisk: null,
  monthly: [],
  /* Where the year first goes under, if it does. The single most useful thing
     on the chart, and the reason it is computed rather than left to be spotted:
     a month that dips below zero in a twelve-column chart is easy to miss. */
  firstDeficitMonth: null,
  worstMonth: null,
});

/**
 * The page's top line.
 *
 * Counts only what is still WAITING. A queue whose headline includes last
 * quarter's agreed requests answers a question nobody on this screen is
 * asking, and it hides the one they are.
 */
function summarise(rows, contexts, budget) {
  const s = emptySummary();

  const pending = rows.filter((r) => !["agreed", "rejected", "withdrawn"].includes(r.state));
  s.waiting = pending.length;

  let worst = null;
  for (const r of pending) {
    const c = contexts[String(r._id)];
    if (!c) continue;

    if (c.kind === "expense") {
      s.requestedExpense += c.amount;
      s.committedImpact += c.committed;
      if (c.verdict === VERDICT.EXCEEDS.id) s.exceeding += 1;
    } else if (c.kind === "revenue") {
      s.requestedRevenue += c.amount;
    } else if (c.kind === "no_head") {
      s.unresolvedHeads += 1;
      /* Still real money being asked for — leaving it out of the headline
         would understate the queue by exactly the requests nobody has
         classified yet. */
      s.requestedExpense += c.amount;
    } else {
      s.unclassified += 1;
    }

    const rank = rankOf(c);
    if (rank > 0 && (!worst || rank > worst.rank || (rank === worst.rank && c.amount > worst.amount))) {
      worst = {
        rank,
        amount: c.amount,
        department: c.department,
        ledgerName: c.ledgerName,
        verdict: c.verdict,
        verdictLabel: c.verdictLabel,
        /* The number that makes it the risk, so the headline can say why. */
        shortfall: c.kind === "expense" && c.availableAfter < 0 ? Math.abs(c.availableAfter) : null,
      };
    }
  }

  /* ── THE CYCLE'S OWN SHAPE ──────────────────────────────────────────────
     Planned net is what the cycle already says. Net after pending is what it
     would say if every waiting request were agreed as it stands — not a
     forecast, an arithmetic consequence, and labelled that way on screen. */
  const items = budget.items || [];
  let plannedRevenue = 0;
  let plannedExpense = 0;
  for (const it of items) {
    const n = variance.natureOf({ nature: it.nature });
    if (n === "revenue") plannedRevenue += money(it.allocatedAmount) || 0;
    else if (n === "expense") plannedExpense += money(it.allocatedAmount) || 0;
  }
  s.plannedNet = plannedRevenue - plannedExpense;
  s.netAfterPending = s.plannedNet + s.requestedRevenue - s.requestedExpense;

  /* A cycle that was in surplus and would not be after agreeing everything
     waiting is worth saying out loud, even when no single request is the
     culprit. */
  if (s.plannedNet >= 0 && s.netAfterPending < 0 && !worst) {
    worst = {
      rank: VERDICT.NET_RISK.rank,
      amount: 0,
      department: null,
      ledgerName: null,
      verdict: VERDICT.NET_RISK.id,
      verdictLabel: VERDICT.NET_RISK.label,
      shortfall: Math.abs(s.netAfterPending),
    };
  }

  s.biggestRisk = worst;
  return s;
}

/**
 * The readings a person takes off the monthly series without counting columns.
 *
 * Running, not per-month: a department can be ₹2L down in June and fine, if
 * May left ₹5L on the table. What matters is whether the year's cumulative
 * position goes under — which is the question "is the net sufficient" actually
 * means.
 */
function readSeries(monthly) {
  let running = 0;
  let firstDeficit = null;
  let worst = null;

  for (const m of monthly) {
    running = round(running + m.netAfterPending);
    if (running < 0 && !firstDeficit) firstDeficit = { key: m.key, cumulative: running };
    if (!worst || running < worst.cumulative) worst = { key: m.key, cumulative: running };
  }

  return { firstDeficitMonth: firstDeficit, worstMonth: worst, closingPosition: running };
}

function rankOf(c) {
  const found = Object.values(VERDICT).find((v) => v.id === c.verdict);
  return found ? found.rank : 0;
}

module.exports = {
  contextFor,
  monthlyFor,
  readSeries,
  buildOne,
  summarise,
  decidingAmount,
  targetDirection,
  pct,
  VERDICT,
};
