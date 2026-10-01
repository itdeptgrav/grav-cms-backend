// routes/CMS_Routes/Manufacturing/CuttingMaster/stageTargetRoutes.js
//
// CUTTING ANSWERS PPC'S TARGET — the receiving department's own door.
//
// Mounted under /api/cms/manufacturing/cutting-master/stage-targets by
// cuttingMasterRoutes.js, behind the same Cutting access rules as the rest of
// the queue: the Cutting department, the acting user's own company, reading
// with viewer and answering with editor.
//
//   GET  /                          the targets in force for a work order or
//                                   a manufacturing order
//   POST /:publicationId/accept     Cutting accepts these dates, for this
//                                   exact published version
//   POST /:publicationId/refuse     Cutting cannot meet them, and says why
//
// Cutting users stay in Cutting: nothing here opens PPC, and no PPC grant
// opens this. PPC cannot answer for Cutting — its own door has no accept
// command — and Cutting cannot edit a PPC date, because nothing here writes
// one. Accepting records no progress: the cut record is still Cutting's own,
// written where it always was.
"use strict";

const express = require("express");

const { handle } = require("../../../../services/storePurchase/errors");
const targets = require("../../../../services/production/cuttingStageTarget.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const cutting = require("./cuttingAccess");

const router = express.Router();

const canRead = [cutting.cuttingDepartment("viewer"), cutting.cuttingCompany];
const canAnswer = [cutting.cuttingDepartment("editor"), cutting.cuttingCompany];

const actor = (req) => (req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null);

/** GET /?workOrderId=…  or  /?moId=… — the targets in force, company-scoped. */
router.get("/", ...canRead, handle(async (req, res) => {
  const { workOrderId, moId } = req.query || {};
  let ids = [];
  if (workOrderId) {
    ids = String(workOrderId).split(",").map((v) => v.trim()).filter(Boolean);
  } else if (cutting.isId(moId)) {
    /* The company's own WorkOrders on that order — the same scope the queue
       uses, so a foreign order simply has none. */
    const rows = await WorkOrder.find({ customerRequestId: moId, ...cutting.workOrderScope(req.cutting.companyId) })
      .select("_id").lean();
    ids = rows.map((r) => String(r._id));
  }
  const byWorkOrder = await targets.targetsByWorkOrder(req.cutting.companyId, ids);
  return res.json({
    success: true,
    targets: [...new Map([...byWorkOrder.values()].map((t) => [t.publicationId, t])).values()],
    byWorkOrder: Object.fromEntries(byWorkOrder),
  });
}));

router.post("/:publicationId/accept", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.cutting.companyId, req.params.publicationId,
    { decision: "ACCEPTED", actor: actor(req) });
  return res.json({ success: true, ...out });
}));

router.post("/:publicationId/refuse", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.cutting.companyId, req.params.publicationId,
    { decision: "REFUSED", reason: req.body?.reason, actor: actor(req) });
  return res.json({ success: true, ...out });
}));

module.exports = router;
