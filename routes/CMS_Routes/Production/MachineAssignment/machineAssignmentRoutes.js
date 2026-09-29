// routes/CMS_Routes/Production/MachineAssignment/machineAssignmentRoutes.js
//
// Mounted at /api/cms/production/machine-assignments. Server-owned machine
// assignment: Machine → WorkOrder → Production execution basis → frozen
// operation. The database is the authority; scanners are brought to it by a
// device-verified toggle barcode (never Firebase).
//
// PLATFORM ADMIN (requirePlatformAdmin — a database-verified admin flag):
//   POST /admin/machines/:machineId/claim     { companyId, reason }
//   GET  /admin/unclaimed-machines            pilot-setup diagnostic
//
// PRODUCTION (session → acting company → Production department grant):
//   GET  /assignable?capacityLineId=          WorkOrder operations that may be assigned
//   GET  /current?workOrderId=&capacityLineId=&operationRowId=
//   GET  /machines/:machineId                 current assignment, sync and history
//   POST /machines/:machineId/assign          { workOrderId, executionBasisId, operationRowId,
//                                               expectedRevision, capacityLineId?, legacyDeviceCode?,
//                                               legacyReason?, reason? }
//   POST /machines/:machineId/reassign        same + reason (required)
//   POST /machines/:machineId/unassign        { expectedRevision, reason }
//   POST /machines/:machineId/device-sync     { reissue? }  evaluate against the newest heartbeat
//   POST /machines/:machineId/device-sync/acknowledge { instructionId, revision }
//
// Every command answer says what is TRUE: `committed` (the database
// assignment), and separately `deviceSync.status` — `applied` only when a
// newer scanner heartbeat matched. A committed assignment is never reported
// as a device success.
"use strict";

const express = require("express");

const { MachineAssignmentError, machineAssignmentService, publicSync } = require("../../../../services/production/machineAssignment/assignment.service");
const { publicAssignment } = require("../../../../services/production/machineAssignment/assignment.rules");
const { productionDepartment } = require("../productionDepartmentAccess");

function defaultDeps() {
  const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
  const requirePlatformAdmin = require("../../../../Middlewear/requirePlatformAdmin");
  const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
  const { Acc_Company } = require("../../../../models/Accountant_model/Acc_MasterModels");
  return {
    authenticate: EmployeeAuthMiddleware,
    resolveCompany: merchandisingCompanyMiddleware({ domainLabel: "Production" }),
    requireEditor: productionDepartment("editor", "Machine assignment"),
    requireViewer: productionDepartment("viewer", "Machine assignment"),
    requireAdmin: requirePlatformAdmin,
    companyExists: async (id) => Boolean(await Acc_Company.exists({ _id: id })),
    service: machineAssignmentService,
  };
}

function createMachineAssignmentRouter(deps = defaultDeps()) {
  const router = express.Router();
  const { authenticate, resolveCompany, requireEditor, requireViewer, requireAdmin, companyExists, service } = deps;

  const fail = (res, error) => {
    if (error instanceof MachineAssignmentError) return res.status(error.status).json(error.toResponse());
    console.error("[machine-assignment]", error);
    return res.status(500).json({ success: false, message: "Something went wrong." });
  };
  const actorOf = (req) => ({ id: req.user?.id ?? null, name: req.user?.name ?? "" });
  const companyOf = (req) => req.merchandising?.companyId ?? null;

  /* ── platform admin ──────────────────────────────────────────────────── */
  const admin = express.Router();
  admin.use(requireAdmin);
  admin.post("/machines/:machineId/claim", async (req, res) => {
    try {
      const { companyId, reason } = req.body || {};
      const out = await service().claim({ machineId: req.params.machineId, companyId, reason, actor: actorOf(req), companyExists });
      res.status(out.claimed ? 201 : 200).json({ success: true, claimed: out.claimed, ownership: {
        companyId: String(out.ownership.companyId), claimedAt: out.ownership.claimedAt,
        claimedBy: out.ownership.claimedBy?.name || "", reason: out.ownership.reason } });
    } catch (e) { fail(res, e); }
  });
  admin.get("/unclaimed-machines", async (_req, res) => {
    try { res.json({ success: true, machines: await service().unclaimedMachines() }); } catch (e) { fail(res, e); }
  });
  router.use("/admin", admin);

  /* ── Production ──────────────────────────────────────────────────────── */
  const prod = express.Router();
  prod.use(authenticate, resolveCompany);

  prod.get("/assignable", requireViewer, async (req, res) => {
    try { res.json({ success: true, workOrders: await service().assignableOperations({ companyId: companyOf(req), capacityLineId: req.query.capacityLineId }) }); }
    catch (e) { fail(res, e); }
  });
  prod.get("/current", requireViewer, async (req, res) => {
    try {
      const { workOrderId, capacityLineId, operationRowId } = req.query;
      res.json({ success: true, assignments: await service().currentAssignments({ companyId: companyOf(req), workOrderId, capacityLineId, operationRowId }) });
    } catch (e) { fail(res, e); }
  });
  prod.get("/machines/:machineId", requireViewer, async (req, res) => {
    try { res.json({ success: true, machine: await service().machineView({ companyId: companyOf(req), machineId: req.params.machineId }) }); }
    catch (e) { fail(res, e); }
  });

  const commandRoute = (kind) => async (req, res) => {
    try {
      const out = await service()[kind]({ ...(req.body || {}), companyId: companyOf(req), machineId: req.params.machineId, actor: actorOf(req) });
      // The device state is evaluated straight away, best effort: it can never
      // turn a committed assignment into a failure, nor claim device success.
      let deviceSync = null;
      try {
        deviceSync = (await service().evaluate({ companyId: companyOf(req), machineId: req.params.machineId })).deviceSync;
      } catch { /* the committed assignment stands; sync is re-evaluated on the next read */ }
      res.status(out.reused ? 200 : 201).json({
        success: true,
        committed: true,
        reused: Boolean(out.reused),
        ...(out.commitOutcome ? { commitOutcome: out.commitOutcome } : {}),
        revision: out.transition.toRevision,
        transition: { kind: out.transition.kind, fromRevision: out.transition.fromRevision, toRevision: out.transition.toRevision },
        assignment: publicAssignment(out.assignment),
        deviceSync: publicSync(deviceSync),
      });
    } catch (e) {
      if (e instanceof MachineAssignmentError) {
        const body = e.toResponse();
        // 503 is the ONE answer where the database outcome is unknown.
        return res.status(e.status).json({ ...body, committed: e.status === 503 ? "unknown" : false });
      }
      return fail(res, e);
    }
  };
  prod.post("/machines/:machineId/assign", requireEditor, commandRoute("assign"));
  prod.post("/machines/:machineId/reassign", requireEditor, commandRoute("reassign"));
  prod.post("/machines/:machineId/unassign", requireEditor, commandRoute("unassign"));

  prod.post("/machines/:machineId/device-sync", requireEditor, async (req, res) => {
    try {
      const out = await service().evaluate({ companyId: companyOf(req), machineId: req.params.machineId, reissue: req.body?.reissue === true });
      res.json({ success: true, superseded: Boolean(out.superseded), deviceSync: publicSync(out.deviceSync) });
    } catch (e) { fail(res, e); }
  });
  prod.post("/machines/:machineId/device-sync/acknowledge", requireEditor, async (req, res) => {
    try {
      const { instructionId, revision } = req.body || {};
      const out = await service().acknowledge({ companyId: companyOf(req), machineId: req.params.machineId, instructionId, revision, actor: actorOf(req) });
      res.json({ success: true, reused: out.reused, deviceSync: publicSync(out.deviceSync) });
    } catch (e) { fail(res, e); }
  });
  router.use(prod);

  return router;
}

module.exports = createMachineAssignmentRouter();
module.exports.createMachineAssignmentRouter = createMachineAssignmentRouter;
