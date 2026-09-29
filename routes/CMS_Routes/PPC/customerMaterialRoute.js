// routes/CMS_Routes/PPC/customerMaterialRoute.js
//
// WHAT CUSTOMER MATERIAL PRODUCTION CAN SEE — AND ONLY SEE.
//
// On a job-work order the customer sends the fabric. A planner deciding whether a
// line can start needs to know whether it is here, how much of it has been issued
// to their order, and whether a shortage is about to stop them. Until now they had
// to ask Store, which meant a phone call and a number written on paper.
//
// ── READ ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────
// There is no write route on this file and there will not be one in this phase.
// Issuing customer material is a physical act Store performs, with Store's grant,
// against an exact lot — and giving PPC a generic stock control would mean
// somebody who cannot see the rack deciding which roll leaves it. A read answers
// the planner's question without moving anything.
//
// ── AND IT IS OFFERED ONLY WHERE THE LINK IS PROVABLE ───────────────────────
// A production order sees customer material only when the stored references
// agree: this company, this order, and — where a work order asks — its own
// `salesLineLink.lineRef`. An order whose link cannot be proved gets an explicit
// "not linked" answer rather than somebody else's material, because a plausible
// wrong answer here becomes a planning decision.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle, fail } = require("../../../services/storePurchase/errors");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const availability = require("../../../services/ppc/customerMaterialAvailability.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });
/* The planner's own read grant. No new capability: seeing what is available for a
   line one is planning is exactly what `planning.read` is for, and a
   `ppc.customerMaterial.read` would be a second place to grant the same thing. */
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);

const ctx = (req) => ({ ...req.ppc, ...req.merchandising });

/**
 * Customer material for one Manufacturing Order.
 *
 * Every line the customer is sending for this order, with what is available in
 * Store, what has been issued to this order, what is left to issue, and whether
 * a shortage is blocking.
 */
router.get("/manufacturing-orders/:orderId/customer-materials", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await availability.forManufacturingOrder(ctx(req), {
      orderId: req.params.orderId,
    });
    return res.json({ success: true, ...out });
  }));

/**
 * The same, narrowed to one WorkOrder's own sales line.
 *
 * A work order makes ONE commercial line, and only the material sent for that
 * line is relevant to it — showing the order's whole material list on a work
 * order would invite somebody to plan against fabric that belongs to a different
 * line of the same order.
 */
router.get("/work-orders/:workOrderId/customer-materials", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await availability.forWorkOrder(ctx(req), {
      workOrderId: req.params.workOrderId,
    });
    return res.json({ success: true, ...out });
  }));

module.exports = router;
