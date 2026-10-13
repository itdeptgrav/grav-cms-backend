"use strict";

const DEFAULT_BASE_URL = "https://api.sarvam.ai";
const DEFAULT_MODEL = "bulbul:v4-flash";
const DEFAULT_VOICE = "simran_en_customer";
const DEFAULT_ODIA_MODEL = "bulbul:v3";
const DEFAULT_ODIA_VOICE = "simran";
const CACHE_LIMIT = 32;

// Keep this list server-owned. The browser may select a presentation voice,
// but it cannot choose an arbitrary upstream model or speaker identifier.
const VOICE_OPTIONS = Object.freeze([
  { id: "simran_en_customer", label: "Simran · Indian customer voice", accent: "Indian English / Hinglish", languages: ["en", "hi"] },
  { id: "shubh_enhi_ads", label: "Shubh · Hinglish voice", accent: "Indian English / Hinglish", languages: ["en", "hi"] },
  { id: "simran", label: "Simran · Odia voice", accent: "Odia", languages: ["od"] },
  { id: "shubh", label: "Shubh · Odia voice", accent: "Odia", languages: ["od"] },
]);
const SELECTABLE_VOICE_IDS = new Set(VOICE_OPTIONS.map(({ id }) => id));
const VOICE_BY_ID = new Map(VOICE_OPTIONS.map((voice) => [voice.id, voice]));
const audioCache = new Map();
const inFlight = new Map();
let lastSuccessfulAt = null;

function config() {
  const requestedPace = Number(process.env.SARVAM_TTS_PACE || 1.05);
  const requestedTemperature = Number(process.env.SARVAM_TTS_TEMPERATURE || 0.55);
  return {
    baseUrl: String(process.env.SARVAM_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: String(process.env.SARVAM_API_KEY || "").trim(),
    model: process.env.SARVAM_TTS_MODEL || DEFAULT_MODEL,
    voice: process.env.SARVAM_TTS_VOICE || DEFAULT_VOICE,
    odiaModel: process.env.SARVAM_TTS_ODIA_MODEL || DEFAULT_ODIA_MODEL,
    odiaVoice: process.env.SARVAM_TTS_ODIA_VOICE || DEFAULT_ODIA_VOICE,
    pace: Number.isFinite(requestedPace) ? Math.min(2, Math.max(0.5, requestedPace)) : 1.05,
    temperature: Number.isFinite(requestedTemperature) ? Math.min(1, Math.max(0.01, requestedTemperature)) : 0.55,
    timeoutMs: Number(process.env.SARVAM_TTS_TIMEOUT_MS) || 45000,
  };
}

function health() {
  const cfg = config();
  return {
    provider: "sarvam",
    configured: Boolean(cfg.apiKey),
    reachable: lastSuccessfulAt ? true : null,
    lastSuccessfulAt,
    model: cfg.model,
    defaultVoice: SELECTABLE_VOICE_IDS.has(cfg.voice) ? cfg.voice : DEFAULT_VOICE,
    defaultVoices: {
      en: VOICE_BY_ID.get(cfg.voice)?.languages.includes("en") ? cfg.voice : DEFAULT_VOICE,
      hi: VOICE_BY_ID.get(cfg.voice)?.languages.includes("hi") ? cfg.voice : DEFAULT_VOICE,
      od: VOICE_BY_ID.get(cfg.odiaVoice)?.languages.includes("od") ? cfg.odiaVoice : DEFAULT_ODIA_VOICE,
    },
    voices: VOICE_OPTIONS,
    releaseBlocked: true,
    releaseBlockReason: "employment_release_review",
  };
}

function validateVoice(value, fallback, language) {
  const requested = String(value || "").trim();
  const selected = requested || fallback || DEFAULT_VOICE;
  if (!SELECTABLE_VOICE_IDS.has(selected)) {
    const error = new Error("Select one of the available Sarvam interviewer voices.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  if (!VOICE_BY_ID.get(selected)?.languages.includes(language)) {
    const error = new Error("Select a Sarvam interviewer voice that supports this language.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  return selected;
}

function languageCode(language) {
  const selected = String(language || "en").trim().toLowerCase();
  if (selected === "en") return "en-IN";
  if (selected === "hi") return "hi-IN";
  if (selected === "od") return "od-IN";
  const error = new Error("Select one of the available interview languages.");
  error.code = "INVALID_INPUT";
  throw error;
}

function contentType(codec) {
  return codec === "wav" ? "audio/wav" : `audio/${codec}`;
}

async function synthesize(text, { fetchImpl = globalThis.fetch, voice, language } = {}) {
  const cfg = config();
  if (!cfg.apiKey) {
    const error = new Error("Sarvam voice is not configured.");
    error.code = "VOICE_NOT_CONFIGURED";
    throw error;
  }
  const input = String(text || "").trim().slice(0, 2500);
  if (!input) {
    const error = new Error("Question text is required.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  const selectedLanguageId = String(language || "en").trim().toLowerCase();
  const selectedLanguage = languageCode(selectedLanguageId);
  const fallbackVoice = selectedLanguageId === "od" ? cfg.odiaVoice : cfg.voice;
  const selectedVoice = validateVoice(voice, fallbackVoice, selectedLanguageId);
  const selectedModel = selectedLanguageId === "od" ? cfg.odiaModel : cfg.model;
  const codec = "wav";
  const cacheKey = JSON.stringify([cfg.baseUrl, selectedModel, selectedVoice, selectedLanguage, cfg.pace, cfg.temperature, input]);
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = synthesizeUncached(input, {
    ...cfg,
    model: selectedModel,
    voice: selectedVoice,
    languageCode: selectedLanguage,
    codec,
  }, fetchImpl).then((result) => {
    audioCache.set(cacheKey, result);
    while (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value);
    return result;
  }).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  return request;
}

async function synthesizeUncached(input, cfg, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/text-to-speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": cfg.apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        text: input,
        language_code: cfg.languageCode,
        model: cfg.model,
        speaker: cfg.voice,
        pace: cfg.pace,
        temperature: cfg.temperature,
        speech_sample_rate: 24000,
        output_audio_codec: cfg.codec,
      }),
    });
    if (!response.ok) {
      const error = new Error(`Sarvam returned HTTP ${response.status}.`);
      error.code = response.status === 401 || response.status === 403 ? "VOICE_AUTH_FAILED" : "VOICE_UPSTREAM_ERROR";
      throw error;
    }
    const body = await response.json();
    const encoded = Array.isArray(body?.audios) ? body.audios[0] : "";
    const bytes = Buffer.from(String(encoded || ""), "base64");
    if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
      const error = new Error("Sarvam returned invalid WAV audio.");
      error.code = "VOICE_UPSTREAM_INVALID_AUDIO";
      throw error;
    }
    lastSuccessfulAt = new Date().toISOString();
    console.log(`[Sarvam TTS] synthesized ${bytes.length} WAV bytes`);
    return { bytes, contentType: contentType(cfg.codec), provider: "sarvam", requestId: body.request_id || null };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("Sarvam took too long to prepare the question.");
      timeout.code = "VOICE_UPSTREAM_TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VOICE_OPTIONS, config, health, synthesize };
