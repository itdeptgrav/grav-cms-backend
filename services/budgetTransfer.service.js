/**
 * GRAV-CMS-BACKEND/services/budgetTransfer.service.js
 *
 * Moving approved amount from one budget line to another.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * You cannot move money that has already been spent. `allocatedAmount` alone
 * is not availability: a line with ₹1L allocated and ₹90k consumed has ₹10k to
 * give, and transferring against the allocation would leave the source
 * instantly over budget through no act of its own. Availability is therefore
 * computed from EVALUATED actuals — the same posted vouchers every other
 * figure in this module reads — and re-checked when finance approves, because
 * spend keeps arriving between the ask and the decision.
 *
 * Extracted from routes/Accountant_Routes/Acc_budgets.js when departments got
 * their own way to ask. A second copy of "what can this line give away" would
 * eventually disagree with the first, and the looser one would be the accident.
 */

const actuals = require("./budgetActuals.service");
const variance = require("./budgetVariance.service");

/** Budget states whose lines may still be moved between. */
const TRANSFERABLE_STATES = ["active", "review", "exceeded"];

/** States a transfer is still waiting on someone in.
 *  "reviewed" is NOT one: the enum is submitted|approved|rejected|cancelled,
 *  and listing it here was a value that could never match. The authoritative
 *  copy now lives in budgetDuplicates.service — this is kept only for callers
 *  that already import it. */
const OPEN_STATES = ["submitted"];

/**
 * What each line can actually give away, right now.
 *
 * Returns a Map of line id → `{ allocated, actual, remaining }`, with
 * `remaining` floored at zero: a line already over budget has nothing to
 * give, and a negative availability would let an overspent line fund another.
 */
async function availabilityFor({ companyId, budget, items }) {
  const hydrated = await actuals.hydrateLines({
    companyId: budget?.companyId ?? companyId ?? undefined,
    lines: items.map((i) => ({
      _id: i._id,
      ledgerId: i.ledgerId,
      nature: i.nature,
      allocatedAmount: i.allocatedAmount,
    })),
    from: budget.startDate,
    to: budget.endDate,
  });

  return new Map(
    hydrated.map((h) => {
      const allocated = variance.money(h.allocatedAmount) ?? 0;
      const actual = variance.money(h.actual) ?? 0;
      return [String(h._id), { allocated, actual, remaining: Math.max(0, allocated - actual) }];
    }),
  );
}

/**
 * Both sides of a transfer, resolved and checked.
 *
 * `isUsableId` is passed in rather than imported so the caller keeps its own
 * idea of what a usable id is — the two routes already agree, and a third
 * definition here would be one more thing to keep in step.
 */
async function resolveSides({ companyId, budget, fromItemId, toItemId, isUsableId }) {
  const usable = isUsableId || ((v) => Boolean(v));
  if (!usable(fromItemId) || !usable(toItemId)) {
    return { error: { status: 404, message: "Budget line not found" } };
  }
  if (String(fromItemId) === String(toItemId)) {
    return { error: { status: 400, message: "A transfer needs two different lines." } };
  }

  const from = budget.items.id(fromItemId);
  const to = budget.items.id(toItemId);
  if (!from || !to) return { error: { status: 404, message: "Budget line not found" } };

  /* Expense and revenue are not the same currency of decision. Moving a sales
   * target into a freight budget would make both numbers meaningless and the
   * net figure silently wrong. */
  const fromNature = from.nature === "revenue" ? "revenue" : "expense";
  const toNature = to.nature === "revenue" ? "revenue" : "expense";
  if (fromNature !== toNature) {
    return {
      error: {
        status: 400,
        message: `Cannot transfer between a ${fromNature} line and a ${toNature} one — they are different kinds of number.`,
      },
    };
  }

  const avail = await availabilityFor({ companyId, budget, items: [from, to] });
  return { from, to, avail };
}

/** The frozen picture of a line at the moment the transfer was raised. */
function snapshotOf(item, a) {
  return {
    department: item.department || null,
    ledgerId: item.ledgerId || undefined,
    ledgerName: item.ledgerName || null,
    groupName: item.groupName || null,
    nature: item.nature || "expense",
    allocatedAmount: a.allocated,
    actual: a.actual,
    remaining: a.remaining,
  };
}

/** The refusal when an ask exceeds what the source can give, said in figures. */
function tooMuchMessage(from, a) {
  const r = (n) => Math.round(n).toLocaleString("en-IN");
  return `${from.ledgerName || "That line"} has only ₹${r(a.remaining)} left to give — ₹${r(a.actual)} of its ₹${r(a.allocated)} is already spent.`;
}

module.exports = {
  TRANSFERABLE_STATES,
  OPEN_STATES,
  availabilityFor,
  resolveSides,
  snapshotOf,
  tooMuchMessage,
};
