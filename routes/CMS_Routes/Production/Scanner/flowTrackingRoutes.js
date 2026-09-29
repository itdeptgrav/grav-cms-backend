// routes/CMS_Routes/Production/Scanner/flowTrackingRoutes.js
//
// Mounted at /api/cms/production/supervisor, AFTER supervisorFloorRoutes and
// machineIntelligenceRoutes, so it can only ADD /flow paths and never shadow
// one of theirs. Read-only.
//
//   GET /flow?capacityLineId=           the active work of ONE PPC planning
//                                       line of the acting company (required;
//                                       a company-wide view is refused)
//       ?operationCode=                 narrow which edges return
//       ?machineId=                     edges whose CURRENT server-owned assignment
//                                       puts that (company-owned) machine on them
//       ?zoneId=                        needs a canvas layout owned by the company;
//                                       otherwise ZONE_CONTEXT_UNAVAILABLE
//   GET /flow/work-orders/:workOrderId  one work order of that company
//
// The route source is the Production execution basis on each WorkOrder. This
// is a planning-line projection, NOT a physical floor: every response carries
// `siteScope: not_modelled` and `physicalLineMapping: unavailable`.
//
//   both: ?windowMinutes= (15–480, default 60) for the recent rates
//         ?asOf=<ISO-8601> to answer as of an earlier instant
//
// Phase 1 of Production Flow Tracking. All arithmetic is in
// services/production/flowTracking/flowWip.js; nothing here computes.
//
// Authentication, then the acting COMPANY, resolved server-side from the
// actor's own memberships by the shared company middleware Packaging and
// Finishing use — `X-Costing-Company` only selects among memberships the actor
// holds, and nothing in the query string is ever authority. A session with no
// provable company is refused before any production record is read.

const express = require("express");

const {
  FlowTrackingError,
  flowTrackingService,
} = require("../../../../services/production/flowTracking/flowTracking.service");

function defaultDeps() {
  const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
  const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
  return {
    authenticate: EmployeeAuthMiddleware,
    resolveCompany: merchandisingCompanyMiddleware({ domainLabel: "Production Flow" }),
    service: flowTrackingService,
  };
}

function createFlowTrackingRouter(deps = defaultDeps()) {
  const router = express.Router();
  const { authenticate, resolveCompany, service } = deps;

  // The company middleware leaves the proved company on req.merchandising.
  const companyOf = (req) => req.merchandising?.companyId ?? null;

  const fail = (res, error, label) => {
    if (error instanceof FlowTrackingError) return res.status(error.status).json(error.toResponse());
    console.error(`Error computing ${label}:`, error);
    return res.status(500).json({ success: false, message: "Server error" });
  };

  // Scoped to /flow so the other routers on this prefix are untouched.
  router.use("/flow", authenticate, resolveCompany);

  router.get("/flow", async (req, res) => {
    try {
      const { asOf, windowMinutes, zoneId, machineId, operationCode, capacityLineId } = req.query;
      const flow = await service().activeFlow({
        companyId: companyOf(req), capacityLineId, asOf, windowMinutes, zoneId, machineId, operationCode,
      });
      res.json({ success: true, ...flow });
    } catch (error) {
      fail(res, error, "production flow");
    }
  });

  router.get("/flow/work-orders/:workOrderId", async (req, res) => {
    try {
      const { asOf, windowMinutes } = req.query;
      const flow = await service().workOrderFlow({
        companyId: companyOf(req), workOrderId: req.params.workOrderId, asOf, windowMinutes,
      });
      res.json({ success: true, ...flow });
    } catch (error) {
      fail(res, error, "work-order flow");
    }
  });

  return router;
}

module.exports = createFlowTrackingRouter();
module.exports.createFlowTrackingRouter = createFlowTrackingRouter;
