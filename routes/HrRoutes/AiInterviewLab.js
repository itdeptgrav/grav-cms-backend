"use strict";

const express = require("express");
const multer = require("multer");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const interview = require("../../services/hr/aiInterviewLab.service");
const interviewTts = require("../../services/hr/indicSpeakTts.service");
const interviewSpeech = require("../../services/hr/interviewSpeech.service");

const router = express.Router();
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

function errorResponse(res, error) {
  if (error?.code === "INVALID_INPUT") return res.status(400).json({ success: false, message: error.message });
  if (error?.code === "VOICE_NOT_CONFIGURED") return res.status(503).json({ success: false, code: error.code, message: error.message });
  if (error?.code === "VOICE_AUTH_FAILED") return res.status(502).json({ success: false, code: error.code, message: "Indic-Speak rejected the configured Bodhan API key." });
  if (error?.code === "VOICE_UPSTREAM_TIMEOUT") return res.status(504).json({ success: false, code: error.code, message: error.message });
  if (error?.code === "VOICE_UPSTREAM_ERROR" || error?.code === "VOICE_UPSTREAM_INVALID_AUDIO") {
    return res.status(502).json({ success: false, code: error.code, message: error.message });
  }
  if (error?.code === "HR_COMPANY_CONTEXT_REQUIRED") return res.status(409).json({ success: false, code: error.code, message: error.message });
  if (error?.code === "MODEL_WARMING") return res.status(503).json({ success: false, code: error.code, message: "GRAV Speech is warming up. Please retry shortly." });
  if (error?.code === "GRAV_SPEECH_TIMEOUT") return res.status(504).json({ success: false, code: error.code, message: error.message });
  if (error instanceof interview.OllamaError) {
    return res.status(error.code === "OLLAMA_TIMEOUT" ? 504 : 503).json({ success: false, code: error.code, message: error.message });
  }
  console.error("AI interview lab error:", error);
  return res.status(502).json({ success: false, code: error?.code || "AI_INTERVIEW_FAILED", message: "The interview service could not complete this request." });
}

router.get("/health", EmployeeAuthMiddleware, async (_req, res) => {
  const [qwen, voice, speech] = await Promise.all([interview.getQwenHealth(), interviewTts.health(), interviewSpeech.health()]);
  res.json({ success: true, data: { qwen, interviewVoice: voice, gravSpeech: speech, policy: { humanReviewRequired: true, videoBehaviourInference: false } } });
});

router.post("/follow-up", EmployeeAuthMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await interview.generateFollowUp(req.body || {}) });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/opening", EmployeeAuthMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await interview.createOpening(req.body || {}) });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/score", EmployeeAuthMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await interview.scoreAnswer(req.body || {}) });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/turn", EmployeeAuthMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await interview.assessTurn(req.body || {}) });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/report", EmployeeAuthMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await interview.generateInterviewReport(req.body || {}) });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/voice", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const translated = await interview.translateQuestion(req.body?.text, req.body?.spokenLanguage);
    const result = await interviewTts.synthesize(translated.spokenText, { voice: req.body?.voice, language: translated.language });
    res.set("X-GRAV-Spoken-Language", translated.language);
    res.set("X-GRAV-Translated", String(translated.translated));
    res.type(result.contentType).send(result.bytes);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/transcribe", EmployeeAuthMiddleware, audioUpload.single("file"), async (req, res) => {
  try {
    const result = await interviewSpeech.transcribeAnswer({ req, file: req.file });
    /* Raw speech-service fields are returned without LLM/manual rewriting. */
    res.json({ success: true, data: result });
  } catch (error) {
    errorResponse(res, error);
  }
});

module.exports = router;
