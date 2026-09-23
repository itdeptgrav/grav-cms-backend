// routes/CMS_Routes/Manufacturing/Embroidery/stageTargetRoutes.js
//
// EMBROIDERY ANSWERS PPC'S TARGET — the receiving department's own door.
//
// Mounted under /api/cms/manufacturing/embroidery/stage-targets by
// embroideryRoutes.js, behind the same Embroidery access rules as the rest of
// the floor: the Embroidery department, the acting user's own company,
// reading with viewer and answering with editor.
//
//   GET  /                          the targets in force for a work order or
//                                   a manufacturing order
//   POST /:publicationId/accept     Embroidery accepts these dates, for this
//                                   exact published version
//   POST /:publicationId/refuse     it cannot meet them, and says why
//
// ── WHO IS ANSWERING ────────────────────────────────────────────────────────
// The signed-in session, always. The floor's badge sign-in names the operator
// who does the embroidery — that identity belongs to a piece scan, not to a
// commitment about dates — so it is never read here, and nothing in a body
// can name the responder.
//
// One answer covers the line's whole target however many WorkOrders display
// it, PPC cannot answer for Embroidery (its own door has no accept command),
// and nothing here writes a PPC date, a piece scan, a booking or a release.
"use strict";

const express = require("express");

const { handle } = require("../../../../services/storePurchase/errors");
const targets = require("../../../../services/production/embroideryStageTarget.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const emb = require("./embroideryAccess");

const router = express.Router();

const canRead = [emb.embroideryDepartment("viewer"), emb.embroideryCompany];
const canAnswer = [emb.embroideryDepartment("editor"), emb.embroideryCompany];

/* The authenticated session — never the floor badge, never a body field. */
const actor = (req) => (req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null);

/** GET /?workOrderId=…  or  /?moId=… — the targets in force, company-scoped. */
router.get("/", ...canRead, handle(async (req, res) => {
  const { workOrderId, moId } = req.query || {};
  let ids = [];
  if (workOrderId) {
    ids = String(workOrderId).split(",").map((v) => v.trim()).filter(Boolean);
  } else if (emb.isId(moId)) {
    const rows = await WorkOrder.find({ customerRequestId: moId, ...emb.workOrderScope(req.embroidery.companyId) })
      .select("_id").lean();
    ids = rows.map((r) => String(r._id));
  }
  const byWorkOrder = await targets.targetsByWorkOrder(req.embroidery.companyId, ids);
  return res.json({
    success: true,
    /* One row per target, however many work orders carry it. */
    targets: [...new Map([...byWorkOrder.values()].map((t) => [t.publicationId, t])).values()],
    byWorkOrder: Object.fromEntries(byWorkOrder),
  });
}));

router.post("/:publicationId/accept", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.embroidery.companyId, req.params.publicationId,
    { decision: "ACCEPTED", actor: actor(req) });
  return res.json({ success: true, ...out });
}));

router.post("/:publicationId/refuse", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.embroidery.companyId, req.params.publicationId,
    { decision: "REFUSED", reason: req.body?.reason, actor: actor(req) });
  return res.json({ success: true, ...out });
}));

module.exports = router;
