// routes/CMS_Routes/Manufacturing/WorkOrder/salesLineLinkRoutes.js
//
// THE SALES LINE ↔ WORK ORDER BRIDGE, READ-ONLY.
//
// Mounted under /api/cms/manufacturing/work-orders/sales-line-links by
// workOrderRoutes.js (which already applies EmployeeAuthMiddleware).
//
//   GET /lines?lineRef=LN-…[&lineRef=LN-…]           line → WorkOrders
//   GET /work-orders?workOrderId=…[&workOrderId=…]    WorkOrder → line
//
// Both accept a repeated or comma-separated parameter, at most 200 keys.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// The company is the actor's OWN membership, resolved server-side by the shared
// company middleware (the X-Costing-Company header only selects among
// memberships they hold). Nothing outside that company is returned or
// described: a foreign, unknown or historical record reads `unlinked`.
// Reading is a PPC capability (viewer), because PPC is the consumer; nothing
// here writes.
"use strict";

const express = require("express");
const { handle } = require("../../../../services/storePurchase/errors");
const { ppcCapability, CAPABILITY } = require("../../../../services/ppc/access.service");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const bridge = require("../../../../services/production/salesLineWorkOrderLink.service");

const router = express.Router();

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "the Sales line bridge" });
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);

/** `?k=a&k=b` and `?k=a,b` both mean [a, b]. */
const listParam = (value) => (Array.isArray(value) ? value : [value])
  .flatMap((v) => String(v ?? "").split(","))
  .map((v) => v.trim())
  .filter(Boolean);

router.get("/lines", requireCompany, canRead, handle(async (req, res) => {
  const lines = await bridge.workOrdersForLines(req.merchandising.companyId, listParam(req.query.lineRef));
  return res.json({ success: true, companyId: String(req.merchandising.companyId), lines });
}));

router.get("/work-orders", requireCompany, canRead, handle(async (req, res) => {
  const workOrders = await bridge.linesForWorkOrders(req.merchandising.companyId, listParam(req.query.workOrderId));
  return res.json({ success: true, companyId: String(req.merchandising.companyId), workOrders });
}));

module.exports = router;
