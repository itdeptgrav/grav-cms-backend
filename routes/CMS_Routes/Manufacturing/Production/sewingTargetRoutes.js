// routes/CMS_Routes/Manufacturing/Production/sewingTargetRoutes.js
//
// PRODUCTION ANSWERS PPC'S SEWING TARGET — the receiving manager's own door.
//
// Mounted at /api/cms/manufacturing/production/sewing-targets, behind the
// Production Manager rules in ./productionTargetAccess.js: the
// `project-manager` grant, the acting user's own company, reading with viewer
// and answering with editor.
//
//   GET  /                          the sewing targets in force for a work
//                                   order or a manufacturing order, with
//                                   whether this signed-in person may answer
//   POST /:publicationId/accept     Production will sew this window, for this
//                                   exact published version
//   POST /:publicationId/refuse     it cannot, and says why
//
// ── WHO IS ANSWERING ────────────────────────────────────────────────────────
// The signed-in session, always. Nothing in a body can name the responder,
// the company or the work order, and no operator badge is read here: a badge
// names who sews a piece, which is a fact about a piece, not a commitment
// about dates.
//
// One answer covers the Sales line's whole target however many WorkOrders
// display it. PPC cannot answer for Production — its own door has no accept
// command — and nothing here writes a PPC date, a capacity booking, a work
// order, a scan, a progress actual or a Production release.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../../services/storePurchase/errors");
const targets = require("../../../../services/production/sewingStageTarget.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const pm = require("./productionTargetAccess");

const router = express.Router();

/* Stated on the router itself, as manufacturingOrderRoutes.js does, rather
   than inherited from whichever /api/cms mount happens to sit above it. */
router.use(EmployeeAuthMiddleware);

const canRead = [pm.productionDepartment("viewer"), pm.productionCompany];
const canAnswer = [pm.productionDepartment("editor"), pm.productionCompany];

/* The authenticated session — never a body field, never a badge. */
const actor = (req) => (req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null);

/** GET /?workOrderId=…  or  /?moId=… — the targets in force, company-scoped. */
router.get("/", ...canRead, handle(async (req, res) => {
  const { workOrderId, moId } = req.query || {};
  let ids = [];
  if (workOrderId) {
    ids = String(workOrderId).split(",").map((v) => v.trim()).filter(Boolean);
  } else if (pm.isId(moId)) {
    const rows = await WorkOrder.find({ customerRequestId: moId, ...pm.workOrderScope(req.production.companyId) })
      .select("_id").lean();
    ids = rows.map((r) => String(r._id));
  }
  const byWorkOrder = await targets.targetsByWorkOrder(req.production.companyId, ids);
  return res.json({
    success: true,
    /* What this signed-in person may do with a published target, decided by
       the server from their own grant. The screen draws Accept and Refuse
       from this; the guard on the answer routes is what enforces it. */
    access: { canRespond: await pm.canAnswerTargets(req) },
    /* One row per target, however many work orders carry it. */
    targets: [...new Map([...byWorkOrder.values()].map((t) => [t.publicationId, t])).values()],
    byWorkOrder: Object.fromEntries(byWorkOrder),
  });
}));

router.post("/:publicationId/accept", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.production.companyId, req.params.publicationId,
    { decision: "ACCEPTED", actor: actor(req) });
  return res.json({ success: true, ...out });
}));

router.post("/:publicationId/refuse", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.production.companyId, req.params.publicationId,
    { decision: "REFUSED", reason: req.body?.reason, actor: actor(req) });
  return res.json({ success: true, ...out });
}));

module.exports = router;
