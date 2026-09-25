// routes/CMS_Routes/PPC/orderTargetsRoute.js
//
// PPC SETS PIECE TARGETS; THE FLOOR READS THEM. Mounted at /api/cms/ppc.
//
//   GET  /targets/orders                     every order PPC can target
//   GET  /targets/orders/:moId?date=          one order: each department's
//                                            done / target / standing
//   POST /targets/orders/:moId               set (or replace) a department's target
//   POST /targets/:targetId/cancel           end a target early
//   GET  /targets/department/:dept?date=     what a department's overview shows
//   GET  /targets/meta                       departments, kinds and their wording
//
// The PPC doors are company-scoped and need a PPC role (read to see, write to
// set). The department door needs only a signed-in CMS session: the numbers on
// it are the department's own, and the page is already inside that portal.
"use strict";

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const { merchandisingCompanyMiddleware } = require("../../../services/companyContext/merchandisingScope.service");
const svc = require("../../../services/ppc/orderTargets.service");
const ev = require("../../../services/ppc/orderTargets.evaluate");
const shift = require("../../../services/manufacturing/shiftHours");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);
const canSet = ppcCapability(CAPABILITY.PLANNING_WRITE);
const companyOf = (req) => req.merchandising.companyId;
const actor = (req) => ({ userId: String(req.user?.id || ""), name: String(req.user?.name || ""), email: String(req.user?.email || "").toLowerCase() });
const dayOf = (raw) => (/^\d{4}-\d{2}-\d{2}$/.test(String(raw || "")) ? String(raw) : shift.istDayWindow().label);

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof svc.TargetError) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[ppc targets]", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

router.get("/targets/meta", (_req, res) => res.json({
  success: true,
  departments: svc.DEPARTMENTS.map((d) => ({ key: d, ...ev.DEPARTMENT_META[d] })),
  kinds: svc.KINDS.map((k) => ({ key: k, ...ev.KIND_META[k] })),
  shift: shift.SHIFT,
}));

router.get("/targets/orders", requireCompany, canRead, wrap(async (req, res) => {
  res.json({ success: true, orders: await svc.listOrders(companyOf(req)) });
}));

router.get("/targets/orders/:moId", requireCompany, canRead, wrap(async (req, res) => {
  if (!svc.isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
  const detail = await svc.orderDetail(companyOf(req), req.params.moId, dayOf(req.query.date));
  if (!detail) return res.status(404).json({ success: false, message: "That order was not found." });
  res.json({ success: true, ...detail });
}));

/* A dry run: the same validation and sentence the save would produce, so the
   form can show "this means …" before anything is written. */
router.post("/targets/orders/:moId/preview", requireCompany, canRead, wrap(async (req, res) => {
  if (!svc.isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
  res.json({ success: true, ...(await svc.previewTarget(companyOf(req), req.params.moId, req.body)) });
}));

router.post("/targets/orders/:moId", requireCompany, canSet, wrap(async (req, res) => {
  if (!svc.isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
  const out = await svc.setTarget(companyOf(req), req.params.moId, req.body, actor(req));
  res.json({ success: true, message: `Target set — ${out.description}`, ...out });
}));

router.post("/targets/:targetId/cancel", requireCompany, canSet, wrap(async (req, res) => {
  if (!svc.isId(req.params.targetId)) return res.status(400).json({ success: false, message: "Not a target id." });
  const out = await svc.cancelTarget(companyOf(req), req.params.targetId, actor(req), req.body?.reason);
  res.json({ success: true, message: "Target cancelled.", ...out });
}));

router.get("/targets/department/:department", wrap(async (req, res) => {
  const department = String(req.params.department || "").toLowerCase();
  if (!svc.DEPARTMENTS.includes(department)) return res.status(404).json({ success: false, message: "No such department." });
  res.json({ success: true, ...(await svc.departmentDay(department, dayOf(req.query.date))) });
}));

module.exports = router;
