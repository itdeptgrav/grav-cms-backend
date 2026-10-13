"use strict";

/*
 * VoiceStudio remains a separately operated, unmodified HTTP service. This
 * repository contains only the small TTS protocol adapter below; no
 * VoiceStudio source, model code, or weights are linked or distributed here.
 * Deployment still has to satisfy VoiceStudio's licence and the selected
 * voice model's separate terms.
 */

function config() {
  const usageMode = String(process.env.VOICESTUDIO_USAGE_MODE || "disabled").trim().toLowerCase();
  const requestedSpeed = Number(process.env.VOICESTUDIO_SPEED || 1.1);
  return {
    baseUrl: String(process.env.VOICESTUDIO_URL || "http://127.0.0.1:3900").replace(/\/+$/, ""),
    apiKey: process.env.VOICESTUDIO_API_KEY || "",
    model: process.env.VOICESTUDIO_TTS_MODEL || "",
    voice: process.env.VOICESTUDIO_VOICE || "",
    speed: Number.isFinite(requestedSpeed) ? Math.min(2, Math.max(0.5, requestedSpeed)) : 1.1,
    usageMode,
    commerciallyCleared: usageMode === "commercial" && process.env.VOICESTUDIO_COMMERCIAL_CLEARANCE === "1",
    internalMvpAccepted: usageMode === "internal_mvp" && process.env.VOICESTUDIO_AGPL_ACKNOWLEDGED === "1",
  };
}

// Base interview questions are asked repeatedly while a rubric is tested.
// Keep a small process-local WAV cache so replay is immediate without turning
// generated audio into a durable HR record.
const audioCache = new Map();
const inFlight = new Map();
const CACHE_LIMIT = 32;
const VOICE_OPTIONS = Object.freeze([
  { id: "af_heart", label: "Heart · American female", accent: "American English" },
  { id: "hf_alpha", label: "Alpha · Indian female", accent: "Hindi / Indian" },
  { id: "hf_beta", label: "Beta · Indian female", accent: "Hindi / Indian" },
  { id: "hm_omega", label: "Omega · Indian male", accent: "Hindi / Indian" },
  { id: "hm_psi", label: "Psi · Indian male", accent: "Hindi / Indian" },
]);
const SELECTABLE_VOICE_IDS = new Set(VOICE_OPTIONS.map(({ id }) => id));

const headers = (cfg, extra = {}) => ({ ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}), ...extra });

function assertEnabled(cfg) {
  if (!cfg.commerciallyCleared && !cfg.internalMvpAccepted) {
    const err = new Error("VoiceStudio is disabled. Configure commercial clearance or explicitly acknowledge internal-MVP AGPL use.");
    err.code = "VOICE_NOT_CLEARED";
    throw err;
  }
}

async function health({ fetchImpl = globalThis.fetch } = {}) {
  const cfg = config();
  const voiceSettings = { defaultVoice: cfg.voice || "af_heart", voices: VOICE_OPTIONS };
  if (!cfg.commerciallyCleared && !cfg.internalMvpAccepted) {
    return { configured: false, reachable: false, reason: "licence_acknowledgement_required", usageMode: cfg.usageMode, ...voiceSettings };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/.well-known/voicestudio-speech`, { headers: headers(cfg), signal: controller.signal });
    return {
      configured: true,
      reachable: response.ok,
      usageMode: cfg.usageMode,
      releaseBlocked: !cfg.commerciallyCleared,
      ...voiceSettings,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      usageMode: cfg.usageMode,
      releaseBlocked: !cfg.commerciallyCleared,
      ...voiceSettings,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesize(text, { fetchImpl = globalThis.fetch, voice, language } = {}) {
  const cfg = config();
  assertEnabled(cfg);
  const input = String(text || "").slice(0, 2000);
  const requestedVoice = String(voice || "").trim();
  if (requestedVoice && !SELECTABLE_VOICE_IDS.has(requestedVoice)) {
    const err = new Error("Select one of the available interview voices.");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const selectedVoice = requestedVoice || cfg.voice || "af_heart";
  const selectedLanguage = String(language || "en").trim().toLowerCase();
  if (selectedLanguage !== "en" && selectedLanguage !== "hi") {
    const err = new Error("Select one of the available interview languages.");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const cacheKey = JSON.stringify([cfg.baseUrl, cfg.model, selectedVoice, selectedLanguage, cfg.speed, input]);
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = synthesizeUncached(input, { ...cfg, voice: selectedVoice, language: selectedLanguage }, fetchImpl).then((result) => {
    audioCache.set(cacheKey, result);
    while (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value);
    return result;
  }).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  return request;
}

async function synthesizeUncached(input, cfg, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.VOICESTUDIO_TIMEOUT_MS) || 45000);
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: headers(cfg, { "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        input,
        response_format: "wav",
        speed: cfg.speed,
        language: cfg.language,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.voice ? { voice: cfg.voice } : {}),
      }),
    });
    if (!response.ok) {
      const err = new Error(`VoiceStudio returned HTTP ${response.status}.`);
      err.code = "VOICE_UPSTREAM_ERROR";
      throw err;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "audio/wav";
    if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
      const err = new Error("VoiceStudio returned an invalid WAV response.");
      err.code = "VOICE_UPSTREAM_INVALID_AUDIO";
      throw err;
    }
    console.log(`[VoiceStudio] synthesized ${bytes.length} WAV bytes`);
    return { bytes, contentType };
  } catch (error) {
    if (error?.name === "AbortError") {
      const err = new Error("VoiceStudio took too long to prepare the question.");
      err.code = "VOICE_UPSTREAM_TIMEOUT";
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VOICE_OPTIONS, config, health, synthesize };
