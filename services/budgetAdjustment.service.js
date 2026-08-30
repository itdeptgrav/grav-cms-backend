/**
 * GRAV-CMS-BACKEND/services/budgetAdjustment.service.js
 *
 * The arithmetic of changing an allocation after it is in force.
 *
 * ── WHY BOTH NUMBERS ARE ALWAYS STORED ──────────────────────────────────────
 * There are two ways to ask: "₹5L more" (a delta) and "make it ₹25L" (a
 * destination). A reader — the finance queue, the department's own history,
 * a report — should never have to know which was typed in order to answer
 * "what will this become?". So whichever one is stated, the other is derived
 * from the line's current allocation and both are stored.
 *
 * Extracted from routes/Accountant_Routes/Acc_budgets.js when departments got
 * their own way to ask. Two copies of this rule would be two ideas of what a
 * supplementary is, and the looser one would be the accident.
 */

const variance = require("./budgetVariance.service");

/** Budget states whose allocations may still be adjusted. */
const ADJUSTABLE_STATES = ["active", "review", "exceeded"];

/** The two shapes an ask can take. */
const TYPES = ["supplementary", "revision"];

/**
 * Turn whichever amount was stated into both.
 *
 * Returns `{ ok: true, delta, next }` or `{ ok: false, message }`.
 */
function resolveAmounts({ type, currentAllocatedAmount, requestedDeltaAmount, requestedNewAmount }) {
  const current = variance.money(currentAllocatedAmount) ?? 0;

  if (type === "supplementary") {
    const delta = variance.money(requestedDeltaAmount);
    if (delta === null) {
      return { ok: false, message: "requestedDeltaAmount must be a number" };
    }
    /* A supplementary is by definition MORE. A negative one is a revision
     * downward wearing the wrong label, and letting it through would mean two
     * names for one operation and a list nobody can read at a glance. */
    if (delta <= 0) {
      return {
        ok: false,
        message:
          "requestedDeltaAmount must be greater than 0 — to reduce an allocation, request a revision instead",
      };
    }
    return { ok: true, delta, next: current + delta };
  }

  const next = variance.money(requestedNewAmount);
  if (next === null) return { ok: false, message: "requestedNewAmount must be a number" };
  if (next < 0) return { ok: false, message: "requestedNewAmount must be ≥ 0" };
  return { ok: true, delta: next - current, next };
}

/** States an adjustment is still waiting on someone in. */
const OPEN_STATES = ["submitted", "reviewed"];

/*  moved to budgetDuplicates.service, where all four
 * flows' duplicate rules live together — four separate copies of "is there
 * already an open one" is how one of them ends up naming a state that cannot
 * occur. */

module.exports = { ADJUSTABLE_STATES, TYPES, OPEN_STATES, resolveAmounts };
