/**
 * GRAV-CMS-BACKEND/services/budgetControl.service.js
 *
 * Is there budget for this spend, and what happens to the budget if we post it?
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Chunks 1–5 made the budget observable: allocations are real, actuals come
 * from posted vouchers, and every figure can be drilled to the vouchers behind
 * it. All of that is retrospective. This is the first piece that looks at
 * money BEFORE it moves — the check that runs when Accounts is about to post
 * spend and asks whether the head it is charging has room.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not block. It reports. The decision to refuse a post and demand an
 * override reason belongs to the route, because only the route knows whether
 * this call is a draft being saved or money actually being committed, and a
 * service that threw would take that judgement away from it.
 *
 * ── EXPENSE ONLY ────────────────────────────────────────────────────────────
 * A revenue budget is a TARGET, not a cap. Beating it is the point. Revenue
 * lines are evaluated and returned for context but can never produce a status
 * that demands an override — treating a sales head like a spend limit would
 * block the company for succeeding.
 */

const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const actuals = require("./budgetActuals.service");
const variance = require("./budgetVariance.service");

/**
 * Which budgets are live enough to control spend.
 *
 * `exceeded` is deliberately included alongside `active`. A budget that has
 * already been blown is exactly the one that most needs the next voucher
 * checked against it; dropping it here would mean the control silently
 * switches OFF the moment it starts to matter.
 *
 * draft/collecting/review are not yet in force, and closed is over.
 */
const CONTROLLING_STATUSES = ["active", "exceeded"];

/* Mirrors `warnAtPct` in budgetVariance.service.js — the point at which a
 * head has consumed enough of its number to be worth saying so. */
const WARN_AT_PCT = 90;

const STATUS_RANK = {
  ok: 0,
  unscoped: 1,
  missing_budget: 2,
  warning_near_limit: 3,
  over_budget: 4,
};

/** The louder of two statuses. Same rule as severity: worst wins, never an
 *  average — an averaged warning is one that fails to fire. */
function worstStatus(a, b) {
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a;
}

/** Statuses that a human has to answer for before money moves. */
function needsOverride(status) {
  return status === "over_budget" || status === "missing_budget";
}

/**
 * Collapse a voucher's entries to one proposed movement per ledger head.
 *
 * A voucher can charge the same head twice (a split allocation), and checking
 * each entry separately would compare two half-amounts against the same
 * remaining balance and clear both — the classic way an over-budget voucher
 * passes a per-line check.
 */
function proposedByLedger(ledgerEntries = []) {
  const out = new Map();
  for (const e of ledgerEntries) {
    if (!e || !e.ledgerId) continue;
    const key = String(e.ledgerId);
    const amount = variance.money(e.amount) ?? 0;
    const prev = out.get(key) || { ledgerId: e.ledgerId, debit: 0, credit: 0, department: null };
    if (e.type === "Cr") prev.credit += amount;
    else prev.debit += amount;
    /* An entry may name its own department (a cost-centre style allocation).
     * The first one wins; a head charged to two departments on one voucher is
     * checked against the head as a whole, which is the safer reading. */
    if (!prev.department && e.department) prev.department = e.department;
    out.set(key, prev);
  }
  return [...out.values()];
}

/**
 * Budget availability for a proposed voucher.
 *
 * @param {object}  args
 * @param {*}       args.companyId      books this voucher belongs to
 * @param {Date|string} args.voucherDate the date the spend lands on
 * @param {Array}   args.ledgerEntries  [{ ledgerId, type: "Dr"|"Cr", amount, department? }]
 * @param {string}  [args.department]   voucher-level department, if the form has one
 * @param {*}       [args.excludeVoucherId] a voucher already posted whose own
 *        movement must not be double-counted when re-checking it (edit flow)
 *
 * @returns {{ overallStatus, requiredOverride, results, message, checkedAt }}
 */
async function checkBudgetAvailability({
  companyId,
  voucherDate,
  ledgerEntries = [],
  department = null,
  excludeVoucherId = null,
} = {}) {
  const checkedAt = new Date();
  const proposed = proposedByLedger(ledgerEntries);

  /* No company context means the actuals cannot be scoped, and an unscoped
   * check would compare this company's spend against every company's postings.
   * Say so rather than returning a confident wrong answer. */
  if (!actuals.oid(companyId)) {
    return {
      overallStatus: "unscoped",
      requiredOverride: false,
      results: [],
      message: "No company selected, so budget availability could not be checked.",
      checkedAt,
    };
  }

  if (!proposed.length) {
    return {
      overallStatus: "ok",
      requiredOverride: false,
      results: [],
      message: "Nothing to check.",
      checkedAt,
    };
  }

  const when = voucherDate ? new Date(voucherDate) : new Date();
  if (Number.isNaN(when.getTime())) {
    throw new Error("voucherDate must be a valid date");
  }

  /* The nature of each head, from the ledger tree rather than any snapshot —
   * the same authority budgetActuals uses. */
  const natures = await actuals.natureByLedger(proposed.map((p) => p.ledgerId));

  const cid = actuals.oid(companyId);
  const budgets = await Acc_Budget.find({
    status: { $in: CONTROLLING_STATUSES },
    startDate: { $lte: when },
    endDate: { $gte: when },
    /* Same legacy clause as every other budget read: a row written before
     * companyId existed still belongs to whoever is looking at it. */
    $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }],
  })
    .select("_id name status period financialYear startDate endDate companyId items")
    .lean();

  const results = [];

  for (const p of proposed) {
    const meta = natures.get(String(p.ledgerId)) || {};
    /* NO DEFAULT TO "expense". A ledger whose nature cannot be resolved is
     * not silently treated as spend — see the asset/liability skip below for
     * why that default was actively dangerous. */
    const nature = meta.nature || null;
    const signed = p.debit - p.credit;
    const thisVoucher = actuals.actualFrom({ signed }, nature);
    const lineDepartment = p.department || department || null;

    const base = {
      ledgerId: p.ledgerId,
      ledgerName: meta.ledgerName || null,
      groupName: meta.groupName || null,
      nature,
      department: lineDepartment,
      debit: p.debit,
      credit: p.credit,
      thisVoucher,
    };

    /* ── ONLY EXPENSE HEADS ARE BUDGET-CONTROLLED ───────────────────────
     * Nearly every voucher has a funding leg — the bank it was paid from,
     * the vendor it is owed to, the cash it came out of. Those are assets
     * and liabilities, not spend, and no budget is ever written against
     * them. An earlier draft of this defaulted an unresolved nature to
     * "expense", which meant the bank leg of a perfectly ordinary payment
     * came back "HDFC Current has no approved allocation" and the voucher
     * was refused. That is not a strict control; it is a control that
     * blocks everything, which people would (rightly) have switched off.
     *
     * A head whose nature cannot be resolved at all lands here too, and
     * that is the correct side to fail on: refusing spend because a ledger
     * is mis-parented punishes the wrong person. The budget screens will
     * still show the overspend afterwards. */
    if (nature !== "expense" && nature !== "revenue") {
      results.push({
        ...base,
        status: "ok",
        note: nature
          ? `${nature} head — not budget-controlled.`
          : "Head has no resolved nature — not budget-controlled.",
        allocated: null,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
      });
      continue;
    }

    /* A revenue head is a target. Reported for context, never a cap — see the
     * file header. It is also why this returns before any allocation lookup:
     * "no revenue budget for this head" is not a finding. */
    if (nature === "revenue") {
      results.push({
        ...base,
        status: "ok",
        note: "Revenue head — budgets are targets, not spend limits.",
        allocated: null,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
      });
      continue;
    }

    /* Every allocation for this head across the live budgets covering the
     * date. Matched on department when the voucher named one; when it did
     * not, the head's TOTAL approved allocation is the cap, because that is
     * genuinely what has been approved for the head. Both sets of lines are
     * named in `budgets` so the caller can show which. */
    const matches = [];
    for (const b of budgets) {
      for (const item of b.items || []) {
        if (!item.ledgerId || String(item.ledgerId) !== String(p.ledgerId)) continue;
        if (lineDepartment && item.department && item.department !== lineDepartment) continue;
        matches.push({ budget: b, item });
      }
    }

    if (!matches.length) {
      results.push({
        ...base,
        status: "missing_budget",
        allocated: 0,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
        note: lineDepartment
          ? `No approved allocation for this head in ${lineDepartment} on a live budget covering ${when.toISOString().slice(0, 10)}.`
          : `No approved allocation for this head on a live budget covering ${when.toISOString().slice(0, 10)}.`,
      });
      continue;
    }

    /* Actuals over the WIDEST window the matched allocations span. Using each
     * budget's own window and summing would double-count spend that falls in
     * two overlapping budgets. */
    const from = matches.reduce(
      (min, m) => (!min || m.budget.startDate < min ? m.budget.startDate : min),
      null,
    );
    const to = matches.reduce(
      (max, m) => (!max || m.budget.endDate > max ? m.budget.endDate : max),
      null,
    );

    /* Posted vouchers only — movementByLedger's own filter. Drafts and
     * pending-approval vouchers are not money yet, and Tally's optional
     * entries never were. Same source as every other actual in the module,
     * which is the only way this check can agree with the budget screen. */
    const movements = await actuals.movementByLedger({
      companyId: m_companyFor(matches, companyId),
      ledgerIds: [p.ledgerId],
      from,
      to,
      /* Re-checking a voucher that is ALREADY posted (an edit) would otherwise
       * find its own movement in the actual and then add the proposal on top,
       * reporting double what the voucher really does. */
      excludeVoucherId,
    });
    const actual = actuals.actualFrom(movements.get(String(p.ledgerId)), nature);

    const allocated = matches.reduce(
      (s, m) => s + (variance.money(m.item.allocatedAmount) ?? 0),
      0,
    );
    const projectedActual = actual + thisVoucher;
    const remainingAfter = allocated - projectedActual;
    const projectedPct = allocated > 0 ? (projectedActual / allocated) * 100 : null;

    let status = "ok";
    if (allocated <= 0) status = "missing_budget";
    else if (remainingAfter < 0) status = "over_budget";
    else if (projectedPct !== null && projectedPct >= WARN_AT_PCT) status = "warning_near_limit";

    results.push({
      ...base,
      status,
      allocated,
      actual,
      projectedActual,
      remainingAfter,
      projectedPct,
      overBy: remainingAfter < 0 ? -remainingAfter : 0,
      budgets: matches.map((m) => ({
        _id: m.budget._id,
        name: m.budget.name,
        status: m.budget.status,
        itemId: m.item._id,
        department: m.item.department || null,
        allocatedAmount: m.item.allocatedAmount || 0,
      })),
    });
  }

  const overallStatus = results.reduce((acc, r) => worstStatus(acc, r.status), "ok");
  const requiredOverride = results.some((r) => needsOverride(r.status));

  return {
    overallStatus,
    requiredOverride,
    results,
    message: messageFor(overallStatus, results),
    checkedAt,
  };
}

/**
 * A legacy budget carries no companyId, so its actuals fall back to the
 * caller's books — the same rule actualsCompanyFor applies on every other
 * budget read. When the matched allocations disagree, the caller's company
 * wins: it is the one whose books this voucher is being posted to.
 */
function m_companyFor(matches, companyId) {
  const owned = matches.find((m) => m.budget.companyId);
  return owned ? owned.budget.companyId : companyId;
}

function messageFor(status, results) {
  const worst = results.filter((r) => r.status === status);
  switch (status) {
    case "over_budget": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} would go over budget by ₹${Math.round(r.overBy).toLocaleString("en-IN")}.`;
    }
    case "missing_budget": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} has no approved allocation on a live budget for this date.`;
    }
    case "warning_near_limit": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} would reach ${Math.round(r.projectedPct)}% of its allocation.`;
    }
    case "unscoped":
      return "No company selected, so budget availability could not be checked.";
    default:
      return "Within budget.";
  }
}

/**
 * The one gate every posting path goes through.
 *
 * Returns `{ blocked: true, payload }` when the caller must stop and make
 * somebody answer for the spend, or `{ blocked: false, override }` with the
 * metadata to stamp on the voucher.
 *
 * NEVER throws for a budget reason. A control that can crash the posting path
 * is worse than no control at all — it would stop the books over a bug in a
 * warning. An unexpected failure logs and lets the voucher through; the
 * budget screens will still show the overspend afterwards.
 */
async function clearanceFor({ voucher, overrideReason, department = null, user = null } = {}) {
  const reason = String(overrideReason || "").trim();
  try {
    const check = await checkBudgetAvailability({
      companyId: voucher.companyId,
      voucherDate: voucher.voucherDate,
      ledgerEntries: (voucher.ledgerEntries || []).map((e) => ({
        ledgerId: e.ledgerId,
        type: e.type,
        amount: e.amount,
        department: e.department || null,
      })),
      department: department || voucher.department || null,
      /* A voucher that is ALREADY posted must not find its own movement in
       * the actual and count it twice. Harmless on the create/post/approve
       * paths, where it is not posted yet. */
      excludeVoucherId: voucher.status === "posted" ? voucher._id : null,
    });

    if (check.requiredOverride && !reason) {
      return {
        blocked: true,
        check,
        payload: {
          error: check.message,
          code: "BUDGET_OVERRIDE_REQUIRED",
          budgetCheck: check,
        },
      };
    }

    /* Metadata is written whenever an override was NEEDED. A voucher that
     * says "over budget, and here is who said yes and why" is the entire
     * point; one that posts silently is what we had before this chunk. */
    if (!check.requiredOverride) return { blocked: false, check, override: null };

    return {
      blocked: false,
      check,
      override: {
        required: true,
        reason,
        status: check.overallStatus,
        checkedAt: check.checkedAt,
        overriddenBy: user?.id,
        overriddenByName: user?.name || "",
        results: (check.results || [])
          .filter((r) => r.status !== "ok")
          .map((r) => ({
            ledgerId: r.ledgerId,
            ledgerName: r.ledgerName,
            department: r.department,
            status: r.status,
            allocated: r.allocated,
            actual: r.actual,
            thisVoucher: r.thisVoucher,
            projectedActual: r.projectedActual,
            remainingAfter: r.remainingAfter,
          })),
      },
    };
  } catch (e) {
    console.error("[budgetControl] check failed, allowing post:", e.message);
    return { blocked: false, check: null, override: null };
  }
}

module.exports = {
  CONTROLLING_STATUSES,
  WARN_AT_PCT,
  worstStatus,
  needsOverride,
  proposedByLedger,
  checkBudgetAvailability,
  clearanceFor,
};
