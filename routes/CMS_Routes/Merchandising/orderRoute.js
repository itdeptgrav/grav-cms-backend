// routes/CMS_Routes/Merchandising/orderRoute.js
//
// THE ORDERS SALES HAS RELEASED, AND THE MATERIAL REQUESTS RAISED AGAINST THEM
// (7 Oct 2026). Fourth router on the /api/cms/merchandising mount: distinct
// paths, the same access implementation as the execution router.
//
//   GET  /orders                          every released order this company may see
//   GET  /orders/:id                      one order: products, quantities, material need
//   GET  /orders/:id/material-requests    the requests standing against it
//   POST /orders/:id/material-requests    save a draft (or submit at once with `submit: true`)
//   PATCH /orders/:id/material-requests/:rid          edit a draft
//   POST /orders/:id/material-requests/:rid/submit    draft -> open (on the Store's register)
//   POST /orders/:id/material-requests/:rid/withdraw  draft, or open with nothing received -> cancelled
//
// Reads need `merchandising.file.read`; raising a request needs
// `merchandising.requirement.write` — the editor's grant, the same authority
// that writes a file's material requirement.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const { merchandisingCompanyMiddleware } = require("../../../services/companyContext/merchandisingScope.service");
const { CAPABILITY, merchandisingCapability } = require("../../../services/merchandising/access.service");
const orders = require("../../../services/merchandising/orders.service");
const materialRequests = require("../../../services/merchandising/orderMaterialRequest.service");
/* The Store is told when a request is submitted (10 Oct 2026). Fire and
   forget: a mail must never fail the request that caused it. */
const materialRequestMail = require("../../../services/merchandising/materialRequestMail.service");
const tellStore = (out) => {
  if (out?.replayed || !out?.request || out.request.status !== "open") return;
  materialRequestMail.notifyMaterialRequestSubmitted(out.request.order, out.request).catch(() => {});
};

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canRequest = merchandisingCapability(CAPABILITY.REQUIREMENT_WRITE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

router.get("/orders", requireCompany, canRead, handle(async (req, res) => {
  const out = await orders.listOrders(req.merchandising, {
    q: req.query.q, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/orders/:id", requireCompany, canRead, handle(async (req, res) => {
  const out = await orders.getOrder(req.merchandising, { id: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/orders/:id/material-requests", requireCompany, canRead, handle(async (req, res) => {
  const out = await materialRequests.listForOrder(req.merchandising, { orderId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.post("/orders/:id/material-requests", requireCompany, canRequest, handle(async (req, res) => {
  const out = await materialRequests.create(req.merchandising, {
    orderId: req.params.id,
    lines: req.body?.lines,
    note: req.body?.note,
    neededBy: req.body?.neededBy,
    submit: Boolean(req.body?.submit),
    idempotencyKey: String(req.headers["idempotency-key"] || req.body?.idempotencyKey || ""),
    actor: actor(req),
  });
  if (req.body?.submit) tellStore(out);
  return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
}));

/* The goods receipts the Store recorded against one of this order's
   requests, as the merchandiser may read them: the document, QC's detail
   of it, and the same as a PDF (10 Oct 2026, owner). */
router.get("/orders/:id/material-requests/:rid/receipts/:grnId", requireCompany, canRead, handle(async (req, res) => {
  const out = await materialRequests.receiptDocument(req.merchandising, { orderId: req.params.id, requestId: req.params.rid, grnId: req.params.grnId });
  return res.json({ success: true, ...out });
}));
router.get("/orders/:id/material-requests/:rid/receipts/:grnId/pdf", requireCompany, canRead, handle(async (req, res) => {
  const { pdf, fileName } = await materialRequests.receiptPdf(req.merchandising, { orderId: req.params.id, requestId: req.params.rid, grnId: req.params.grnId });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  return res.send(pdf);
}));

/* A draft is the merchandiser's own: edit it, submit it, or withdraw it. An
   open request with nothing received may still be withdrawn. */
router.patch("/orders/:id/material-requests/:rid", requireCompany, canRequest, handle(async (req, res) => {
  const out = await materialRequests.update(req.merchandising, {
    orderId: req.params.id, requestId: req.params.rid,
    lines: req.body?.lines, note: req.body?.note, neededBy: req.body?.neededBy,
    actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/orders/:id/material-requests/:rid/submit", requireCompany, canRequest, handle(async (req, res) => {
  const out = await materialRequests.submit(req.merchandising, {
    orderId: req.params.id, requestId: req.params.rid, actor: actor(req),
  });
  tellStore(out);
  return res.json({ success: true, ...out });
}));

router.post("/orders/:id/material-requests/:rid/withdraw", requireCompany, canRequest, handle(async (req, res) => {
  const out = await materialRequests.withdraw(req.merchandising, {
    orderId: req.params.id, requestId: req.params.rid, reason: req.body?.reason, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
