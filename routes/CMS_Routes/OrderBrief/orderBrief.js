"use strict";
/**
 * routes/CMS_Routes/OrderBrief/orderBrief.js
 * ───────────────────────────────────────────────────────────────────────────
 * GET /api/cms/sales/order-brief/requests/:requestId
 *
 * The buyer-approved order brief for one Order Book record. Read-only: there is
 * no POST, PATCH or DELETE here and there never should be. Every value belongs
 * to the record it came from and is edited THERE — the quotation, the handover,
 * the Merchandising revision, the sample style — so an edit made through this
 * surface would be a second copy of an instruction, and the day the two
 * disagreed nobody could say which was the order.
 *
 * Its own router and its own folder, rather than another route inside the
 * Sales files, so it shares no file with the work that establishes which
 * order a journey points at (services/orderBookLink.js and the PO routes).
 *
 * Behind `salesAuth` like the handover router it sits beside: the brief shows
 * the accepted quotation and the buyer's PO, which are commercial.
 */

const express = require("express");

const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const { buildOrderBrief } = require("../../../services/orderBrief/orderBrief.service");

const router = express.Router();
router.use(salesAuth);

router.get("/requests/:requestId", handle(async (req, res) => {
  const brief = await buildOrderBrief(req, req.params.requestId);
  /* Assembled on every read from records that change underneath it; a cached
     copy would be exactly the stale brief this exists to prevent. */
  res.set("Cache-Control", "no-store");
  return res.json({ success: true, brief });
}));

module.exports = router;
