// routes/CMS_Routes/Inventory/Operations/materialRequests.js
//
// THE STORE'S DOORS ONTO A MERCHANDISER'S MATERIAL REQUEST (7 Oct 2026).
// Mounted at /api/cms/inventory/operations/material-requests, beside the
// purchase orders whose register lists these.
//
//   GET  /:id                 the request, its order, lines and receipts
//   POST /:id/goods-receipts  record a goods receipt against it
//
// The receipt runs the purchase order's own chain — capability, legacy
// refusal, idempotency, unit of work — on a document that has no supplier and
// no price. See services/storePurchase/materialRequestReceipt.service.js.
"use strict";

const express = require("express");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const { handle } = require("../../../../services/storePurchase/errors");
const svc = require("../../../../services/storePurchase/materialRequestReceipt.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

router.get("/:id", requireCapability(CAPABILITIES.READ), handle(async (req, res) => {
  const out = await svc.detail(req.tenant, req.params.id);
  return res.json({ success: true, ...out });
}));

router.post(
  "/:id/goods-receipts",
  requireCapability(CAPABILITIES.RECEIPT_RECORD),
  refuseLegacyWrite,
  withIdempotency("MR_RECEIVE", { target: (req) => req.params.id }),
  handle(async (req, res) => {
    const out = await svc.receive(req.tenant, {
      requestId: req.params.id, body: req.body || {},
      actor: { id: req.user.id, name: req.user.name || "" },
      idempotent: req.idempotent || null,
    });
    const body = {
      success: true,
      message: out.replayed ? "This goods receipt was already recorded." : `Goods receipt ${out.goodsReceipt.receiptNumber} recorded.`,
      goodsReceipt: out.goodsReceipt,
    };
    const status = out.replayed ? 200 : 201;
    return req.idempotent
      ? req.idempotent.succeed(status, body, { entityType: svc.ENTITY, entityId: req.params.id })
      : res.status(status).json(body);
  }),
);

/* ══ RAW ITEM LABELS BEFORE THE RECEIPT IS RECORDED (7 Oct 2026) ═══════════
   The count the purchase receipt runs, on a material-request line: open or
   resume, print N labels of Q each, mark printed, count a scanned one, void,
   undo, cancel — and "adopt", which takes any live raw-item label scanned on
   the receive screen into the matching line's count. Same shapes as the
   purchase-order and customer-material routes, so `lib/receivingSessions.js`
   drives all three with one client. */
const counts = require("../../../../services/storePurchase/materialRequestSession.service");
const canRead = requireCapability(CAPABILITIES.READ);
const canReceive = [requireCapability(CAPABILITIES.RECEIPT_RECORD), refuseLegacyWrite];
const actorOf = (req) => ({ id: req.user?.id || null, name: req.user?.name || "" });

router.get("/:id/receiving-sessions", canRead, handle(async (req, res) => {
  const out = await counts.readForRequest(req.tenant, { requestId: req.params.id });
  return res.json({ success: true, ...out });
}));
router.post("/:id/lines/:lineId/receiving-session", ...canReceive, handle(async (req, res) => {
  const out = await counts.openOrResume(req.tenant, { requestId: req.params.id, lineId: req.params.lineId }, actorOf(req));
  return res.status(out.resumed ? 200 : 201).json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/labels", ...canReceive, handle(async (req, res) => {
  const out = await counts.reserveBatch(req.tenant, {
    sessionId: req.params.sessionId, count: req.body?.count ?? 1, quantityPerLabel: req.body?.quantityPerLabel ?? null,
  }, actorOf(req));
  return res.status(201).json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/labels/printed", ...canReceive, handle(async (req, res) => {
  const out = await counts.markPrinted(req.tenant, { sessionId: req.params.sessionId, barcodeIds: req.body?.barcodeIds || [] });
  return res.json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/labels/:barcodeId/apply", ...canReceive, handle(async (req, res) => {
  const out = await counts.applyLabel(req.tenant, { sessionId: req.params.sessionId, barcodeId: req.params.barcodeId, quantity: req.body?.quantity ?? null });
  return res.json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/labels/:barcodeId/void", ...canReceive, handle(async (req, res) => {
  const out = await counts.voidLabel(req.tenant, {
    sessionId: req.params.sessionId, barcodeId: req.params.barcodeId, reason: req.body?.reason || "", replace: Boolean(req.body?.replace),
  }, actorOf(req));
  return res.json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/undo", ...canReceive, handle(async (req, res) => {
  const out = await counts.undoLast(req.tenant, { sessionId: req.params.sessionId });
  return res.json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/scan", canRead, handle(async (req, res) => {
  const out = await counts.resolveScan(req.tenant, { sessionId: req.params.sessionId, barcodeId: req.body?.barcodeId });
  return res.json({ success: true, ...out });
}));
router.post("/:id/receiving-sessions/:sessionId/cancel", ...canReceive, handle(async (req, res) => {
  const out = await counts.cancel(req.tenant, { sessionId: req.params.sessionId, reason: req.body?.reason || "" }, actorOf(req));
  return res.json({ success: true, ...out });
}));
router.post("/:id/labels/adopt", ...canReceive, handle(async (req, res) => {
  const out = await counts.adoptLabel(req.tenant, { requestId: req.params.id, barcodeId: req.body?.barcodeId, lineId: req.body?.lineId || null }, actorOf(req));
  return res.status(201).json({ success: true, ...out });
}));

module.exports = router;
