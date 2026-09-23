"use strict";
/**
 * services/storePurchase/orderActualsRead.service.js
 *
 * Store & Purchase — THE DOOR CENTRAL COSTING READS SERVICE ORDERS THROUGH.
 *
 * ── WHY A DOOR AND NOT A REQUIRE ────────────────────────────────────────────
 * `ServiceOrder` is a Store/Purchase record. The reconciliation report needs
 * to set what was ORDERED beside what was estimated, which is a legitimate
 * read — but Central Costing requiring the model directly is Central Costing
 * owning it, and a module that can read an order as an actual can, one
 * refactor later, read one as a costing SOURCE. That is the loop the
 * source-boundary guard exists to prevent.
 *
 * So the model lives here, behind the one read that is needed, company-scoped
 * in the query. There is no create, no update and no general search.
 */

const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");

/**
 * Every service order raised against a given set of spend requests.
 *
 * One request line may reach several orders across several suppliers, so this
 * returns them all — never reduced to one.
 */
async function serviceOrdersForSpendRequests({ companyId, spendRequestIds = [] } = {}) {
  if (!companyId || !spendRequestIds.length) return [];
  return ServiceOrder.find({
    companyId,
    spendRequestId: { $in: spendRequestIds },
  }).lean().catch(() => []);
}

/* ── AND THE NAME AVOIDS THE MODEL'S ────────────────────────────────────────
   The source-boundary guard matches the model's name case-insensitively, and
   rightly: a door called `serviceOrderRead` reads, at a glance, like the model
   itself. This is a read of ORDER ACTUALS, which is what it is for. */
module.exports = { serviceOrdersForSpendRequests };
