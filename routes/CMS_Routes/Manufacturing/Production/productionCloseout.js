// routes/CMS_Routes/Manufacturing/Production/productionCloseout.js
//
// CLOSING A PRODUCTION RUN — READ, PREPARE, CLOSE, CORRECT.
//
// ── WHAT NONE OF THESE ENDPOINTS DO ─────────────────────────────────────────
// Write stock. Edit an original issue or return. Post to Accounting. Touch
// payroll. Change an approved costing version. A closeout RECORDS what
// happened; every movement it describes was made elsewhere, by the workflow
// that owns it, and surplus material goes back through the Store's own return
// route exactly as it always did.
//
// ── AND THE FIGURES ARE THE SERVER'S ────────────────────────────────────────
// A request body may say which work order, how the output was classified and
// what became of each material. Every quantity it is checked against — pieces
// completed, pieces accepted, material issued and returned — is read from the
// source records here, and re-read again at close. A draft prepared an hour
// ago is verified against the same authority it was prepared from, so a run
// that moved in the meantime is refused with the refreshed evidence rather
// than frozen at figures that are no longer true.

"use strict";

const express = require("express");

const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const departmentWrites = require("../../../../Middlewear/departmentWriteGuard");
const closeout = require("../../../../services/centralCosting/productionCloseout.service");
const { sendError, handle } = require("../../../../services/storePurchase/errors");
const companyContext = require("../../../../services/centralCosting/companyContext.service");

router.use(EmployeeAuthMiddleware);

/* ── THE AUTHORITY THIS ACTUALLY ENFORCES ───────────────────────────────────
 * The brief asks for three separated actors — Production prepares, QC
 * confirms, a manager closes. This application cannot tell them apart: the
 * production floor, QC and the project manager all reach these records through
 * the same `project-manager` department grant, and there is no narrower role
 * to gate on.
 *
 * So this uses the narrowest existing authority — the same department write
 * guard the Manufacturing Order routes use — and does NOT pretend the
 * separation exists. What it does record, on every prepare, close and
 * correction, is WHO acted and when, so the separation can be audited after
 * the fact and enforced properly once real roles exist.
 */
const productionWrites = (entity) => departmentWrites("project-manager", { entity });

/** The company this actor is acting in, resolved the way costing resolves it. */
async function contextOf(req) {
  const ctx = await companyContext.resolveForActor(req.user, {});
  return { companyId: ctx.companyId, actorId: ctx.actorId };
}
const actorOf = (req) => ({ id: req.user?.id || "", name: req.user?.name || req.user?.email || "" });

/**
 * GET /:workOrderId — the evidence, plus whatever has already been prepared.
 *
 * Pure read. Re-derived from the QC piece ledger and the stock movements every
 * time, so the screen is never showing a cached judgement.
 */
router.get("/:workOrderId", handle(async (req, res) => {
  const ctx = await contextOf(req);
  const evidence = await closeout.evidenceFor(ctx, { workOrderId: req.params.workOrderId });
  const live = await closeout.liveFor(ctx, req.params.workOrderId);
  const history = await closeout.historyFor(ctx, req.params.workOrderId);
  return res.json({
    success: true,
    evidence,
    closeout: live || null,
    readiness: closeout.readinessOf({ evidence, closeout: live }),
    history,
    standing: closeout.STANDING,
  });
}));

/** PUT /:workOrderId/draft — save the classification. */
router.put("/:workOrderId/draft", productionWrites("production-closeout"), handle(async (req, res) => {
  const ctx = await contextOf(req);
  const out = await closeout.saveDraft(ctx, {
    workOrderId: req.params.workOrderId,
    output: req.body?.output || {},
    materials: Array.isArray(req.body?.materials) ? req.body.materials : [],
    actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * POST /:workOrderId/close — freeze it.
 *
 * Idempotent: an identical retry resolves to the same closed record rather
 * than a second one, which the unique index would refuse anyway.
 */
router.post("/:workOrderId/close", productionWrites("production-closeout"), handle(async (req, res) => {
  const ctx = await contextOf(req);
  const out = await closeout.close(ctx, {
    workOrderId: req.params.workOrderId,
    reason: String(req.body?.reason || ""),
    actor: actorOf(req),
    idempotencyKey: req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
  });
  return res.status(out.mode === "RECOVERED" ? 200 : 201).json({ success: true, ...out });
}));

/**
 * POST /:workOrderId/correct — a new revision, with a reason.
 *
 * The closed one is superseded and keeps every figure it was closed with.
 */
router.post("/:workOrderId/correct", productionWrites("production-closeout"), handle(async (req, res) => {
  const ctx = await contextOf(req);
  const out = await closeout.correct(ctx, {
    workOrderId: req.params.workOrderId,
    reason: String(req.body?.reason || ""),
    actor: actorOf(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.use((err, _req, res, _next) => sendError(res, err));

module.exports = router;
