// routes/CMS_Routes/PPC/controlRoute.js
//
// THE PPC CONTROL CENTER — every production-management read, in one router.
// Mounted at /api/cms/ppc (after the targets router), all under /control:
//
//   GET /control/overview?date=                   the landing figures
//   GET /control/orders?…filters                  every production order
//   GET /control/orders/:moId?date=               one order, in full
//   GET /control/orders/:moId/person-wise         the people on a measurement order
//   GET /control/person-wise                      person-wise orders
//   GET /control/work-orders?…filters             every work order
//   GET /control/work-orders/:woId                one work order, in full
//   GET /control/departments                      today's snapshot per department
//   GET /control/departments/:department?date=    one department's page
//   GET /control/hourly?date=&department=&moId=   hour by hour
//   GET /control/daily?from=&to=&department=      day by day
//   GET /control/achievement?from=&to=            target vs achievement
//   GET /control/efficiency?from=&to=             IE efficiency
//   GET /control/delays?date=                     delay / shortfall
//   GET /control/product-variant?product=         one product or variant across orders
//   GET /control/reports                          the catalogue
//   GET /control/reports/:type?…                  one report, as JSON (the CMS
//                                                 builds the workbook from it)
//   GET /control/search?q=                        PO / MO / WO / product / variant / customer / barcode
//   GET /control/assistant/suggestions            what the assistant can answer
//   POST /control/assistant/query { message }     a question, answered from the same services
//
// Every door is read-only, company-scoped and needs a PPC role that can read
// planning (the same rule as the order book and targets). Setting or
// cancelling a target stays on the targets router, which audits it.
"use strict";

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const { merchandisingCompanyMiddleware } = require("../../../services/companyContext/merchandisingScope.service");
const orders = require("../../../services/ppc/control/orders.service");
const reports = require("../../../services/ppc/control/reports.service");
const overview = require("../../../services/ppc/control/overview.service");
const assistant = require("../../../services/ppc/control/assistant/engine");
const { DEPARTMENTS, DEPARTMENT_META, isId } = require("../../../services/ppc/control/ledger.service");
const shift = require("../../../services/manufacturing/shiftHours");

const router = express.Router();
router.use(EmployeeAuthMiddleware);
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);
const companyOf = (req) => req.merchandising.companyId;

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    console.error("[ppc control]", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
const notFound = (res, what) => res.status(404).json({ success: false, message: `${what} was not found.` });

router.use("/control", requireCompany, canRead);

router.get("/control/overview", wrap(async (req, res) => res.json({ success: true, ...(await overview.overview(companyOf(req), req.query)) })));

router.get("/control/orders", wrap(async (req, res) => res.json({ success: true, ...(await orders.listOrders(companyOf(req), req.query)) })));
router.get("/control/person-wise", wrap(async (req, res) => res.json({ success: true, ...(await orders.personWiseOrders(companyOf(req), req.query)) })));
router.get("/control/orders/:moId", wrap(async (req, res) => {
  if (!isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
  const d = await orders.orderDetail(companyOf(req), req.params.moId, /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : undefined);
  return d ? res.json({ success: true, ...d }) : notFound(res, "That order");
}));
router.get("/control/orders/:moId/person-wise", wrap(async (req, res) => {
  if (!isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
  const d = await orders.personWise(companyOf(req), req.params.moId);
  return d ? res.json({ success: true, ...d }) : notFound(res, "That order");
}));

router.get("/control/work-orders", wrap(async (req, res) => res.json({ success: true, ...(await orders.listWorkOrders(companyOf(req), req.query)) })));
router.get("/control/work-orders/:woId", wrap(async (req, res) => {
  if (!isId(req.params.woId)) return res.status(400).json({ success: false, message: "Not a work order id." });
  const d = await orders.workOrderDetail(companyOf(req), req.params.woId);
  return d ? res.json({ success: true, ...d }) : notFound(res, "That work order");
}));

router.get("/control/departments", wrap(async (req, res) => {
  const o = await overview.overview(companyOf(req), req.query);
  res.json({ success: true, date: o.date, isToday: o.isToday, shift: o.shift, departments: o.departments, pipeline: o.pipeline });
}));
router.get("/control/departments/:department", wrap(async (req, res) => {
  const d = await reports.departmentPage(companyOf(req), String(req.params.department || "").toLowerCase(), req.query);
  return d ? res.json({ success: true, ...d }) : notFound(res, "That department");
}));

router.get("/control/hourly", wrap(async (req, res) => res.json({ success: true, ...(await reports.hourly(companyOf(req), req.query)) })));
router.get("/control/daily", wrap(async (req, res) => res.json({ success: true, ...(await reports.daily(companyOf(req), req.query)) })));
router.get("/control/achievement", wrap(async (req, res) => res.json({ success: true, ...(await reports.achievement(companyOf(req), req.query)) })));
router.get("/control/efficiency", wrap(async (req, res) => res.json({ success: true, ...(await reports.efficiency(companyOf(req), req.query)) })));
router.get("/control/delays", wrap(async (req, res) => res.json({ success: true, ...(await reports.delays(companyOf(req), req.query)) })));
router.get("/control/product-variant", wrap(async (req, res) => res.json({ success: true, ...(await reports.productVariant(companyOf(req), req.query)) })));

router.get("/control/reports", (_req, res) => res.json({ success: true, reports: Object.entries(reports.REPORTS).map(([key, r]) => ({ key, ...r })), departments: DEPARTMENTS.map((d) => ({ key: d, ...DEPARTMENT_META[d] })), shift: shift.SHIFT }));
router.get("/control/reports/:type", wrap(async (req, res) => {
  const type = String(req.params.type || "");
  if (!reports.REPORTS[type]) return notFound(res, "That report");
  const d = await reports.report(companyOf(req), type, req.query);
  return d ? res.json({ success: true, ...d }) : res.status(404).json({ success: false, message: "Nothing to report for those filters — check the order, work order or department." });
}));

router.get("/control/search", wrap(async (req, res) => res.json({ success: true, ...(await orders.search(companyOf(req), req.query.q)) })));

router.get("/control/assistant/suggestions", (_req, res) => res.json({ success: true, ...assistant.suggestions() }));
router.post("/control/assistant/query", wrap(async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ success: false, message: "Ask something." });
  res.json({ success: true, ...(await assistant.answer(companyOf(req), message, { history: Array.isArray(req.body?.history) ? req.body.history : [] })) });
}));

module.exports = router;
