"use strict";
// routes/CMS_Routes/PPC/materialRequestsRoute.js
//
// PPC → STORE MATERIAL REQUESTS (4 Oct 2026, owner). Mounted at /api/cms/ppc.
//
//   GET  /material-requests/orders/:moId            the order's requests, each line with what the Store issued against it
//   POST /material-requests/orders/:moId            raise one  { reason, neededBy?, lines:[{rawItemId, variantId?, quantity, unit?, note?}] }
//   POST /material-requests/orders/:moId/:requestId/cancel   { reason }   — only while nothing was issued against it
//   GET  /material-requests/orders/:moId/report     the same, shaped for the Excel export
//
// Reads need PLANNING_READ, writes PLANNING_WRITE — the same rungs as targets
// and the PO fact. The Store reads the same service through its own door
// (routes/CMS_Routes/Store/storeRoutes.js).

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const { merchandisingCompanyMiddleware } = require("../../../services/companyContext/merchandisingScope.service");
const svc = require("../../../services/ppc/materialRequests.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);
const canWrite = ppcCapability(CAPABILITY.PLANNING_WRITE);
const companyOf = (req) => req.merchandising.companyId;
const actor = (req) => ({ userId: String(req.user?.id || ""), name: String(req.user?.name || ""), email: String(req.user?.email || "").toLowerCase() });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
    if (status === 500) console.error("[ppc material-requests]", err);
    return res.status(status).json({ success: false, message: status === 500 ? "Server error" : err.message, ...(err.code ? { code: err.code } : {}) });
  }
};

router.get("/material-requests/orders/:moId", requireCompany, canRead, wrap(async (req, res) => {
  res.json({ success: true, ...(await svc.listForOrder(req.params.moId, { companyId: companyOf(req) })) });
}));

router.post("/material-requests/orders/:moId", requireCompany, canWrite, wrap(async (req, res) => {
  const out = await svc.create(companyOf(req), req.params.moId, req.body || {}, actor(req));
  /* the Store is told, with the lines (best effort) */
  try {
    const { notifyMaterialRequestRaised } = require("../../../services/ppc/materialRequestsNotify.service");
    notifyMaterialRequestRaised(out.order, out.created, actor(req)).catch((e) => console.error("[ppc material-requests] mail:", e?.message || e));
  } catch (e) { console.error("[ppc material-requests] mail setup:", e?.message || e); }
  res.json({ success: true, message: `${out.created?.requestNumber || "The request"} was sent to the Store.`, ...out });
}));

router.post("/material-requests/orders/:moId/:requestId/cancel", requireCompany, canWrite, wrap(async (req, res) => {
  res.json({ success: true, message: "The request was cancelled.", ...(await svc.cancel(companyOf(req), req.params.moId, req.params.requestId, req.body?.reason, actor(req))) });
}));

router.get("/material-requests/orders/:moId/report", requireCompany, canRead, wrap(async (req, res) => {
  res.json({ success: true, ...(await svc.reportForOrder(req.params.moId, { companyId: companyOf(req) })) });
}));

module.exports = router;
