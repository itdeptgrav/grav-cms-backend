"use strict";

const express = require("express");
const Employee = require("../../../../models/Employee");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenantForEmployee } = require("../../../../Middlewear/storePurchaseTenant");
const voice = require("../../../../services/mrfVoiceApproval.service");

const router = express.Router();

function workerAuthenticated(req) {
  const expected = String(process.env.MRF_VOICE_WORKER_SECRET || "");
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return Boolean(expected && supplied.length === expected.length
    && require("crypto").timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}

router.get("/worker/:id/context", async (req, res) => {
  if (!workerAuthenticated(req)) {
    return res.status(401).json({ success: false, message: "Worker authentication failed." });
  }
  try {
    const call = await voice.workerContext({ id: req.params.id });
    if (!call) return res.status(409).json({ success: false, message: "This approval call is no longer active." });
    return res.json({ success: true, call });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

/* The worker owns media, not MRF authority. It can only advance the bounded
 * conversation state. The authenticated approver's browser still submits the
 * resulting command through the existing MRF route. */
router.post("/worker/:id/turn", express.json(), async (req, res) => {
  if (!workerAuthenticated(req)) {
    return res.status(401).json({ success: false, message: "Worker authentication failed." });
  }
  try {
    const result = await voice.workerTurn({ id: req.params.id, ...req.body });
    if (!result) return res.status(409).json({ success: false, message: "This approval call is no longer active." });
    res.json({ success: true, ...result });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

router.post("/worker/:id/no-answer", express.json(), async (req, res) => {
  if (!workerAuthenticated(req)) {
    return res.status(401).json({ success: false, message: "Worker authentication failed." });
  }
  try {
    const call = await voice.workerNoAnswer({ id: req.params.id });
    if (!call) return res.status(409).json({ success: false, message: "This approval call is no longer active." });
    return res.json({ success: true, call });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post("/worker/:id/speech", express.json(), async (req, res) => {
  if (!workerAuthenticated(req)) {
    return res.status(401).json({ success: false, message: "Worker authentication failed." });
  }
  try {
    const call = await voice.workerSpeech({ id: req.params.id, text: req.body?.text });
    if (!call) return res.status(404).json({ success: false, message: "Voice Lab call not found." });
    return res.json({ success: true, call });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post("/worker/:id/dialog", express.json(), async (req, res) => {
  if (!workerAuthenticated(req)) {
    return res.status(401).json({ success: false, message: "Worker authentication failed." });
  }
  try {
    const call = await voice.workerDialog({ id: req.params.id, ...req.body });
    if (!call) return res.status(404).json({ success: false, message: "Voice Lab call not found." });
    return res.json({ success: true, call });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.use(EmployeeAuth);
router.use(requireTenantForEmployee(async (req) => Employee.findOne({
  $or: [
    ...(req.user?.id ? [{ _id: req.user.id }] : []),
    ...(req.user?.employeeId ? [{ biometricId: req.user.employeeId }, { identityId: req.user.employeeId }] : []),
  ],
}).lean()));

const actor = (req) => ({
  companyId: req.tenant.companyId,
  biometricId: req.tenant.actorEmployeeId,
  actorName: req.user?.name || "",
});

router.get("/health", (_req, res) => res.json({ success: true, data: voice.readiness() }));

router.get("/incoming", async (req, res) => {
  try { res.json({ success: true, incoming: await voice.incoming(actor(req)) }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const call = await voice.assigned({ id: req.params.id, ...actor(req) });
    if (!call) return res.status(404).json({ success: false, message: "Approval call not found." });
    res.json({ success: true, call });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

router.post("/:id/accept", async (req, res) => {
  try { res.json({ success: true, ...(await voice.accept({ id: req.params.id, ...actor(req) })) }); }
  catch (error) {
    const status = error.code === "MRF_VOICE_STALE" ? 409 : error.code === "MRF_VOICE_NOT_READY" ? 503 : 500;
    res.status(status).json({ success: false, code: error.code, message: error.message });
  }
});

router.post("/:id/defer", async (req, res) => {
  try {
    const call = await voice.defer({ id: req.params.id, ...actor(req) });
    if (!call) return res.status(409).json({ success: false, message: "This approval call is no longer available." });
    res.json({ success: true, call });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

router.post("/:id/language", async (req, res) => {
  try {
    const call = await voice.setLanguage({ id: req.params.id, language: req.body?.language, ...actor(req) });
    if (!call) return res.status(400).json({ success: false, message: "That voice language is not currently installed." });
    return res.json({ success: true, call });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post("/:id/complete", async (req, res) => {
  try {
    const call = await voice.complete({ id: req.params.id, outcome: req.body?.outcome, ...actor(req) });
    if (!call) return res.status(409).json({ success: false, message: "The confirmed decision did not match this call." });
    res.json({ success: true, call });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

module.exports = router;
