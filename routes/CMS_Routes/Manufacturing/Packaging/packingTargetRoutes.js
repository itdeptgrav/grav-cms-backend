// routes/CMS_Routes/Manufacturing/Packaging/packingTargetRoutes.js
//
// PACKAGING & DISPATCH ANSWERS PPC'S PACKING TARGET — the receiving
// department's own door.
//
// Mounted at /api/cms/manufacturing/packaging/packing-targets, behind the
// rules in ./packingTargetAccess.js: the `packaging-dispatch` grant, the
// acting user's own company, reading with viewer and answering with editor.
// Deliberately its own router rather than a handler inside the existing
// packaging routers, which carry no department role and no company scope —
// see the note in the access module.
//
//   GET  /                          the packing targets in force for a work
//                                   order or a manufacturing order, with
//                                   whether this signed-in person may answer
//   POST /:publicationId/accept     Packaging can pack inside this window,
//                                   for this exact published version
//   POST /:publicationId/refuse     it cannot, and says why
//
// ── WHO IS ANSWERING ────────────────────────────────────────────────────────
// The signed-in session, always. Nothing in a body can name the responder,
// the company or the work order, and no packing badge or barcode is read
// here: those name who packed a unit, which is a fact about a unit, not a
// commitment about dates.
//
// One answer covers the Sales line's whole target however many WorkOrders
// display it. PPC cannot answer for Packaging — its own door has no accept
// command — and nothing here writes a PPC date, a packaging record, a label,
// a scanned unit, a packed quantity, a dispatch challan, a capacity booking
// or a Production release.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../../services/storePurchase/errors");
const targets = require("../../../../services/production/packingStageTarget.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const pkg = require("./packingTargetAccess");

const router = express.Router();

/* Stated on the router itself, as both packaging routers do, rather than
   inherited from whichever /api/cms mount happens to sit above it. */
router.use(EmployeeAuthMiddleware);

const canRead = [pkg.packagingDepartment("viewer"), pkg.packagingCompany];
const canAnswer = [pkg.packagingDepartment("editor"), pkg.packagingCompany];

/* The authenticated session — never a body field, never a badge. */
const actor = (req) => (req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null);

/** GET /?workOrderId=…  or  /?moId=… — the targets in force, company-scoped. */
router.get("/", ...canRead, handle(async (req, res) => {
  const { workOrderId, moId } = req.query || {};
  let ids = [];
  if (workOrderId) {
    ids = String(workOrderId).split(",").map((v) => v.trim()).filter(Boolean);
  } else if (pkg.isId(moId)) {
    const rows = await WorkOrder.find({ customerRequestId: moId, ...pkg.workOrderScope(req.packaging.companyId) })
      .select("_id").lean();
    ids = rows.map((r) => String(r._id));
  }
  const byWorkOrder = await targets.targetsByWorkOrder(req.packaging.companyId, ids);
  return res.json({
    success: true,
    /* What this signed-in person may do with a published target, decided by
       the server from their own grant. The screen draws Accept and Refuse
       from this; the guard on the answer routes is what enforces it. */
    access: { canRespond: await pkg.canAnswerTargets(req) },
    /* One row per target, however many work orders carry it. */
    targets: [...new Map([...byWorkOrder.values()].map((t) => [t.publicationId, t])).values()],
    byWorkOrder: Object.fromEntries(byWorkOrder),
  });
}));

router.post("/:publicationId/accept", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.packaging.companyId, req.params.publicationId,
    { decision: "ACCEPTED", actor: actor(req) });
  return res.json({ success: true, ...out });
}));

router.post("/:publicationId/refuse", ...canAnswer, handle(async (req, res) => {
  const out = await targets.respond(req.packaging.companyId, req.params.publicationId,
    { decision: "REFUSED", reason: req.body?.reason, actor: actor(req) });
  return res.json({ success: true, ...out });
}));

module.exports = router;
