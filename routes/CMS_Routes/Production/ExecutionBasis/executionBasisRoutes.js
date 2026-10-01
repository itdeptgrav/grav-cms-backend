// routes/CMS_Routes/Production/ExecutionBasis/executionBasisRoutes.js
//
// Mounted at /api/cms/production/execution-bases. Production's own receipt of
// a PPC SEWING publication for an existing WorkOrder.
//
//   POST /receive                      { workOrderId, publicationId }
//   POST /supersede                    { workOrderId, publicationId, supersedesBasisId, reason }
//   GET  /work-orders/:workOrderId     the version history, narrow (no routes)
//
// The body carries SELECTORS only. Company, Sales line, IE route, booking,
// planning line, quantity and window are all derived server-side by
// services/production/executionBasis/ and copied into the frozen basis.
//
// Access, in the project's established order:
//   1. authentication (EmployeeAuthMiddleware);
//   2. the acting company, from the actor's own memberships
//      (merchandisingCompanyMiddleware — the header only selects);
//   3. writes need the Production Supervisor department at `editor`, by the
//      same grant/migration rule Packaging's doors use (`roleIn`): once any
//      grant exists in the department it is required; before that, only a
//      session that IS the department passes. Reads need `viewer`.
"use strict";

const express = require("express");

const { ExecutionBasisError, executionBasisService } = require("../../../../services/production/executionBasis/executionBasis.service");
const { summarise } = require("../../../../services/production/executionBasis/executionBasis.rules");

const { productionDepartment } = require("../productionDepartmentAccess");

function defaultDeps() {
  const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
  const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
  return {
    authenticate: EmployeeAuthMiddleware,
    resolveCompany: merchandisingCompanyMiddleware({ domainLabel: "Production" }),
    requireEditor: productionDepartment("editor"),
    requireViewer: productionDepartment("viewer"),
    service: executionBasisService,
  };
}

function createExecutionBasisRouter(deps = defaultDeps()) {
  const router = express.Router();
  const { authenticate, resolveCompany, requireEditor, requireViewer, service } = deps;
  router.use(authenticate, resolveCompany);

  const companyOf = (req) => req.merchandising?.companyId ?? null;
  const actorOf = (req) => ({ id: req.user?.id ?? null, name: req.user?.name ?? "" });
  const fail = (res, error) => {
    if (error instanceof ExecutionBasisError) return res.status(error.status).json(error.toResponse());
    console.error("[production-execution-basis]", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Nothing was changed." });
  };
  const respond = (res, { basis, reused, commitOutcome }) => res.status(reused ? 200 : 201).json({
    success: true,
    created: !reused,
    executionBasis: { ...summarise(basis, { reused }), ...(commitOutcome ? { commitOutcome } : {}) },
  });

  router.post("/receive", requireEditor, async (req, res) => {
    try {
      const { workOrderId, publicationId } = req.body || {};
      respond(res, await service().receive({ companyId: companyOf(req), workOrderId, publicationId, actor: actorOf(req) }));
    } catch (error) { fail(res, error); }
  });

  router.post("/supersede", requireEditor, async (req, res) => {
    try {
      const { workOrderId, publicationId, supersedesBasisId, reason } = req.body || {};
      respond(res, await service().supersede({
        companyId: companyOf(req), workOrderId, publicationId, supersedesBasisId, reason, actor: actorOf(req),
      }));
    } catch (error) { fail(res, error); }
  });

  router.get("/work-orders/:workOrderId", requireViewer, async (req, res) => {
    try {
      const versions = await service().list({ companyId: companyOf(req), workOrderId: req.params.workOrderId });
      res.json({ success: true, versions });
    } catch (error) { fail(res, error); }
  });

  return router;
}

module.exports = createExecutionBasisRouter();
module.exports.createExecutionBasisRouter = createExecutionBasisRouter;
