"use strict";

const express = require("express");
const Employee = require("../../../models/Employee");
const EmployeeAuth = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenantForEmployee } = require("../../../Middlewear/storePurchaseTenant");
const morning = require("../../../services/morningBriefVoice.service");

const router = express.Router();

router.use(EmployeeAuth);
router.use(requireTenantForEmployee(async (req) => Employee.findOne({
  $or: [
    ...(req.user?.id ? [{ _id: req.user.id }] : []),
    ...(req.user?.employeeId ? [{ biometricId: req.user.employeeId }, { identityId: req.user.employeeId }] : []),
    ...(req.user?.email ? [{ email: String(req.user.email).toLowerCase() }] : []),
  ],
}).lean()));

const actor = (req) => ({
  companyId: req.tenant.companyId,
  biometricId: req.tenant.actorEmployeeId,
});

router.get("/morning-brief/preferences", async (req, res) => {
  try {
    const preference = await morning.preferenceForActor(actor(req));
    if (!preference) return res.status(409).json({ success: false, message: "Your employee record is not linked for morning briefs." });
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({ success: true, preference });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Could not load morning brief settings." });
  }
});

router.put("/morning-brief/preferences", async (req, res) => {
  try {
    const preference = await morning.savePreference({ ...actor(req), input: req.body || {} });
    return res.json({ success: true, preference });
  } catch (error) {
    const status = ["MORNING_BRIEF_TIME_INVALID", "MORNING_BRIEF_LANGUAGE_UNAVAILABLE", "MORNING_BRIEF_IDENTITY_MISSING"].includes(error.code) ? 400 : 500;
    return res.status(status).json({ success: false, code: error.code, message: error.message });
  }
});

router.post("/morning-brief/call-now", async (req, res) => {
  try {
    const result = await morning.callNow(actor(req));
    if (!result.call) return res.status(409).json({ success: false, code: result.skipped, message: "A morning brief could not be queued right now." });
    return res.json({ success: true, call: result.call, note: result.skipped || "queued" });
  } catch (error) {
    const status = error.code === "MRF_VOICE_NOT_READY" ? 503 : error.code === "MORNING_BRIEF_IDENTITY_MISSING" ? 409 : 500;
    return res.status(status).json({ success: false, code: error.code, message: error.message });
  }
});

module.exports = router;

