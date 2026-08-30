"use strict";
/**
 * services/budgetPlannedItems.service.js
 *
 * THE PLANNED ITEM INSIDE AN APPROVED HEAD.
 *
 * ── THE DISTINCTION THIS SERVICE EXISTS FOR ─────────────────────────────────
 * A budget head is an accounting bucket: "Software Subscription Expenses".
 * What finance actually agreed to is not the bucket, it is the plan inside it:
 *
 *     Claude Team   5 users × ₹6,000 × 12 = ₹3,60,000   approved
 *     Codex usage   1 × ₹20,000 × 12      = ₹2,40,000   approved
 *     Copilot       5 users × ₹1,000 × 12 = ₹60,000     refused
 *
 * Spending against the HEAD alone lets somebody buy the thing finance refused,
 * out of the money finance approved for something else, and the budget report
 * still balances. The head was never the control; the rows were.
 *
 * ── WHERE THE ROWS ACTUALLY LIVE ────────────────────────────────────────────
 * Not on the approved `items[]` line — that carries only a total. They live on
 * the `budgetRequests[]` entry the line was built from, and the line points
 * back at it through `sourceRequestId`. So the chain is:
 *
 *     items[] line  →  sourceRequestId  →  budgetRequests[]  →  workingLines[]
 *
 * Read rather than copied. Copying the rows onto the line at approval would
 * have produced a second copy that drifts the first time finance revises a
 * counter, and the question "what did they actually agree to" would then have
 * two answers.
 *
 * ── AND WHY ONLY SOME ROWS COUNT ────────────────────────────────────────────
 * A working row carries its own `decision`. A refused row is part of the
 * derivation and must still be readable — it is why the total is what it is —
 * but it is not something anybody may spend against. `countered` is an open
 * question the department has not answered; spending against a number still
 * being argued over is spending against nobody's agreement.
 */

/** Two decimals, or null when it cannot be a number. */
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * A row's stable address.
 *
 * `rowId` is the real one and is what a row written since it existed carries.
 * Rows written before it have none, and position is explicitly NOT identity —
 * the model says so, because a department reordering its ask would silently
 * reattach a decision to a different row.
 *
 * So a legacy row gets a positional key AND every consumer stores the row's
 * NAME beside it. The name is what makes drift detectable: a key that resolves
 * to a differently-named row is refused at validation rather than quietly
 * charged to whatever moved into that slot.
 */
function keyOf(row, index) {
  return row?.rowId ? String(row.rowId) : `pos:${index}`;
}

/** The budgetRequests[] entry an approved line was built from, or null. */
function sourceRequestOf(budget, item) {
  if (!item?.sourceRequestId) return null;
  return (
    (budget?.budgetRequests || []).find(
      (r) => String(r._id) === String(item.sourceRequestId),
    ) || null
  );
}

/**
 * The rows somebody may actually spend against, under one approved line.
 *
 * @returns {Array<{key, name, description, amount, quantity, unit, rate, multiplier}>}
 */
function plannedItemsFor(budget, item) {
  const src = sourceRequestOf(budget, item);
  if (!src) return [];

  return (src.workingLines || [])
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row?.decision === "approved")
    .map(({ row, i }) => ({
      key: keyOf(row, i),
      name: row.label || "Unnamed line",
      description: row.description || null,
      /* What finance agreed, not what was asked. They differ on any row that
         was countered and then accepted, and the asked figure is the one
         nobody approved. */
      amount: money(row.approvedAmount) ?? money(row.amount) ?? 0,
      quantity: money(row.quantity),
      unit: row.unit || null,
      rate: money(row.rate),
      multiplier: money(row.multiplier),
    }))
    /* A row approved at zero is a refusal written politely. Nothing can be
       spent against it, so offering it would be offering an empty envelope. */
    .filter((p) => p.amount > 0);
}

/**
 * Resolve one planned item under one approved line, or null.
 *
 * @param {string} key   the stored `plannedItemKey`
 * @param {string} [name] the stored `plannedItemName`, checked when given —
 *        see keyOf on why a positional key needs its name verifying.
 */
function findPlannedItem(budget, item, key, name = null) {
  if (!key) return null;
  const found = plannedItemsFor(budget, item).find((p) => p.key === String(key));
  if (!found) return null;
  if (name && String(name).trim() && found.name !== String(name).trim()) return null;
  return found;
}

module.exports = { plannedItemsFor, findPlannedItem, sourceRequestOf, keyOf };
