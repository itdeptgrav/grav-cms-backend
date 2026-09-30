// services/inventory/materialSetup.service.js
//
// IS THIS MATERIAL SET UP WELL ENOUGH TO BE REQUESTED, PURCHASED AND MEASURED?
//
// The Materials catalogue answers a maintenance question, not a stock one: does
// the item say what it is (category), what it is used for (usedAs), what it is
// counted in (base unit), and which budget it comes out of (budget head)? This
// module decides that ONCE, on the server, so the register's "Needs setup" view,
// its per-row Setup status and its company-wide counts can never disagree.
//
// ── NOTHING HERE IS RE-DERIVED ──────────────────────────────────────────────
// The budget answer is `itemBudgetHead.headForItem` — the same resolver the
// budget-classification read and the purchase checks use. This module only asks
// whether that answer found a head. When the category mappings could not be
// read, the budget fact is `null` (unknown), never `true` — an unreadable
// mapping is not an unmapped one.
"use strict";

const { DEFAULT_USED_AS } = require("../../models/CMS_Models/Inventory/Products/usedAs");
const itemBudgetHead = require("../itemBudgetHead.service");

const text = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * @param item       a lean RawItem.
 * @param budgetMap  the company's `itemBudgetHead.categoryMap(...)`, or `null`
 *                   when it could not be read.
 */
/* BUDGET IS NOT PART OF SETUP (29 Sep 2026, explicit request: "budget,
   company based and all the concepts are needed to completely remove" from the
   Store). A material is set up when it has a category, an intended use and a
   base unit. The budget-head resolver still exists for the requests desk; it
   no longer flags an item, counts against it or filters the catalogue.
   STORE_BUDGET_SETUP=1 brings the old verdict back. */
const BUDGET_IN_SETUP = process.env.STORE_BUDGET_SETUP === "1";
function setupOf(item = {}, budgetMap = null) {
  const categoryMissing = !(text(item.customCategory) || text(item.category));
  const useUnclassified = !text(item.usedAs) || item.usedAs === DEFAULT_USED_AS;
  const unitMissing = !(text(item.customUnit) || text(item.unit));
  const budgetUnmapped = !BUDGET_IN_SETUP ? false : budgetMap
    ? itemBudgetHead.headForItem(item, budgetMap).source === itemBudgetHead.SOURCE_NONE
    : null;
  const classificationNeeded = categoryMissing || useUnclassified;
  const needsSetup = classificationNeeded || unitMissing || budgetUnmapped === true;
  return { categoryMissing, useUnclassified, unitMissing, budgetUnmapped, classificationNeeded, needsSetup };
}

/** Company-wide maintenance counts. `needBudgetMapping` is null when unknown. */
function countSetup(items = [], budgetMap = null) {
  let needClassification = 0, needBudgetMapping = 0, needUnitSetup = 0, needsSetup = 0;
  for (const it of items) {
    const s = setupOf(it, budgetMap);
    if (s.classificationNeeded) needClassification++;
    if (s.budgetUnmapped === true) needBudgetMapping++;
    if (s.unitMissing) needUnitSetup++;
    if (s.needsSetup) needsSetup++;
  }
  return {
    total: items.length,
    needClassification,
    needBudgetMapping: !BUDGET_IN_SETUP ? 0 : budgetMap ? needBudgetMapping : null,
    needUnitSetup,
    needsSetup,
    budgetAvailable: !BUDGET_IN_SETUP ? true : Boolean(budgetMap),
  };
}

module.exports = { setupOf, countSetup };
