"use strict";
/**
 * test/requests/plannedItems.helper.js
 *
 * Give a seeded budget the PLAN inside each of its heads.
 *
 * ── WHY EVERY SUITE SUDDENLY NEEDS THIS ─────────────────────────────────────
 * A request now spends against a planned item — a row of the department's
 * approved working, e.g. "Claude Team, 5 users × ₹6,000 × 12" — and not merely
 * against the accounting head that holds it. Head-only spending let somebody
 * buy the row finance REFUSED out of the money approved for something else,
 * and the budget report still balanced.
 *
 * Test budgets were written before that and seed `items[]` directly, with no
 * `budgetRequests[]` behind them and so no plan to point at. Rather than write
 * a working breakdown into a dozen seeds by hand, this gives every item on a
 * budget one approved row, keyed `r1`, named after the head.
 *
 * The rows go on `budgetRequests[]` and the item points back through
 * `sourceRequestId`, because that is exactly where the real approval flow puts
 * them — a fixture that stored them somewhere more convenient would be testing
 * a shape the application never produces.
 */
const mongoose = require("mongoose");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");

/** The key every seeded plan uses, so raise helpers can hard-code it. */
const PLANNED_KEY = "r1";

/**
 * @param {object|string} budget  the created budget document, or its id
 * @returns {Promise<object>} the budget, so this can WRAP a create call
 *          (`await planEveryItem(await Acc_Budget.create({...}))`) without the
 *          caller losing the document. Returning the key instead made every
 *          wrapped seed assign a string where a budget was expected.
 */
async function planEveryItem(budget) {
  const id = budget?._id || budget;
  const doc = await Acc_Budget.findById(id);
  if (!doc) throw new Error("planEveryItem: budget not found");

  doc.budgetRequests = doc.budgetRequests || [];

  for (const item of doc.items || []) {
    if (item.sourceRequestId) continue;

    const requestId = new mongoose.Types.ObjectId();
    doc.budgetRequests.push({
      _id: requestId,
      department: item.department,
      ledgerId: item.ledgerId,
      ledgerName: item.ledgerName,
      nature: item.nature || "expense",
      requestedAmount: item.allocatedAmount,
      agreedAmount: item.allocatedAmount,
      state: "agreed",
      workingLines: [
        {
          rowId: PLANNED_KEY,
          label: `${item.ledgerName} plan`,
          description: "Seeded plan row",
          quantity: 1,
          unit: "job",
          rate: item.allocatedAmount,
          multiplier: 1,
          amount: item.allocatedAmount,
          manualAmount: false,
          /* The only decision a request may be raised against. */
          decision: "approved",
          approvedAmount: item.allocatedAmount,
        },
      ],
    });
    item.sourceRequestId = requestId;
  }

  await doc.save();
  return doc;
}

module.exports = { planEveryItem, PLANNED_KEY };
