"use strict";
// routes/CMS_Routes/Store/storeReportsRoutes.js — mounted at /api/cms/store/reports
//
//   GET /day-book?from=YYYY-MM-DD&to=YYYY-MM-DD    the Store's day book (4 Oct 2026, owner)
//
// Same gate as the Store overview the page already reads: a session, a proved
// Store tenant, and the READ capability every Store grant from viewer up holds.

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability, CAPABILITIES } = require("../../../Middlewear/storePurchaseTenant");
const { reportWindow } = require("../../../services/manufacturing/stageReport");
const dayBook = require("../../../services/storePurchase/dayBook.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware, requireTenant, requireCapability(CAPABILITIES.READ));

router.get("/day-book", async (req, res) => {
  try {
    const w = reportWindow(req.query);
    if (w.all) return res.status(400).json({ success: false, message: "The day book covers a day or a span of days — give from and to." });
    const out = await dayBook.dayBook(req.tenant, w);
    return res.json({ success: true, ...out });
  } catch (err) {
    const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
    if (status === 500) console.error("[store reports] day-book", err);
    return res.status(status).json({ success: false, message: status === 500 ? "Server error" : err.message });
  }
});

module.exports = router;
