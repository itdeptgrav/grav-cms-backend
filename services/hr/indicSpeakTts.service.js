"use strict";

const DEFAULT_BASE_URL = "https://api.bodhan.ai/v1";
const DEFAULT_MODEL = "indic-speak";
const DEFAULT_VOICE = "Kavya";
const CACHE_LIMIT = 32;
const DELIVERY_CUE_PATTERN = /\[(pause|short pause|long pause|warm|professional|explain|excited|excitement|neutral)\]/gi;
const STYLE_BY_CUE = Object.freeze({
  warm: "Customer Care",
  professional: "Customer Care",
  explain: "educational lecture",
  excited: "happy",
  excitement: "happy",
  neutral: null,
});
const PAUSE_MS_BY_CUE = Object.freeze({ pause: 450, "short pause": 250, "long pause": 850 });

// The browser may select only these presentation voices. The provider model,
// endpoint, language contract, and credentials remain server-owned.
const VOICE_OPTIONS = Object.freeze([
  { id: "Kavya", label: "Kavya · Hindi voice", accent: "Hindi / Indian English", languages: ["en", "hi"] },
  { id: "Amit", label: "Amit · Hindi voice", accent: "Hindi / Indian English", languages: ["en", "hi"] },
  { id: "Itishree", label: "Itishree · Odia voice", accent: "Odia / Indian English", languages: ["en", "od"] },
  { id: "Akash", label: "Akash · Odia voice", accent: "Odia / Indian English", languages: ["en", "od"] },
]);
const VOICE_BY_ID = new Map(VOICE_OPTIONS.map((voice) => [voice.id, voice]));
const audioCache = new Map();
const inFlight = new Map();
let lastSuccessfulAt = null;

function config() {
  return {
    baseUrl: String(process.env.BODHAN_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: String(process.env.BODHAN_API_KEY || "").trim(),
    model: process.env.BODHAN_TTS_MODEL || DEFAULT_MODEL,
    voice: process.env.BODHAN_TTS_VOICE || DEFAULT_VOICE,
    timeoutMs: Number(process.env.BODHAN_TTS_TIMEOUT_MS) || 45000,
  };
}

function defaultVoice(language, configuredVoice) {
  if (VOICE_BY_ID.get(configuredVoice)?.languages.includes(language)) return configuredVoice;
  if (language === "od") return "Itishree";
  return DEFAULT_VOICE;
}

function health() {
  const cfg = config();
  return {
    provider: "indic-speak",
    configured: Boolean(cfg.apiKey),
    reachable: lastSuccessfulAt ? true : null,
    lastSuccessfulAt,
    model: cfg.model,
    defaultVoice: defaultVoice("en", cfg.voice),
    defaultVoices: {
      en: defaultVoice("en", cfg.voice),
      hi: defaultVoice("hi", cfg.voice),
      od: defaultVoice("od", cfg.voice),
    },
    voices: VOICE_OPTIONS,
    releaseBlocked: true,
    releaseBlockReason: "employment_release_review",
  };
}

function normaliseLanguage(language) {
  const selected = String(language || "en").trim().toLowerCase();
  if (["en", "hi", "od"].includes(selected)) return selected;
  const error = new Error("Select one of the available interview languages.");
  error.code = "INVALID_INPUT";
  throw error;
}

function providerLanguage(language) {
  return language === "od" ? "or" : language;
}

function validateVoice(value, fallback, language) {
  const selected = String(value || fallback || "").trim();
  const option = VOICE_BY_ID.get(selected);
  if (!option) {
    const error = new Error("Select one of the available Indic-Speak interviewer voices.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  if (!option.languages.includes(language)) {
    const error = new Error("Select an Indic-Speak interviewer voice that supports this language.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  return selected;
}

function parseDeliveryScript(value) {
  const source = String(value || "").slice(0, 2500);
  const parts = source.split(DELIVERY_CUE_PATTERN);
  const segments = [];
  let style = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = String(parts[index] || "");
    if (index % 2 === 0) {
      const text = part.trim();
      if (text) segments.push({ type: "speech", text, style });
      continue;
    }
    const cue = part.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PAUSE_MS_BY_CUE, cue)) {
      segments.push({ type: "pause", durationMs: PAUSE_MS_BY_CUE[cue] });
    } else if (Object.prototype.hasOwnProperty.call(STYLE_BY_CUE, cue)) {
      style = STYLE_BY_CUE[cue];
    }
  }
  return segments.slice(0, 12);
}

function parsePcmWav(bytes) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") return null;
  let offset = 12;
  let format = null;
  let pcm = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(bytes.length, start + chunkSize);
    if (chunkId === "fmt " && end - start >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    }
    if (chunkId === "data") pcm = bytes.subarray(start, end);
    offset = start + chunkSize + (chunkSize % 2);
  }
  if (!format || !pcm || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 24000 || format.bitsPerSample !== 16) return null;
  return { format, pcm };
}

function buildPcmWav(pcm, format) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(text, { fetchImpl = globalThis.fetch, voice, language } = {}) {
  const cfg = config();
  if (!cfg.apiKey) {
    const error = new Error("Indic-Speak voice is not configured. Add the server-side Bodhan API key.");
    error.code = "VOICE_NOT_CONFIGURED";
    throw error;
  }
  const input = String(text || "").trim().slice(0, 2500);
  if (!input) {
    const error = new Error("Question text is required.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  const selectedLanguage = normaliseLanguage(language);
  const selectedVoice = validateVoice(voice, defaultVoice(selectedLanguage, cfg.voice), selectedLanguage);
  const apiLanguage = providerLanguage(selectedLanguage);
  const cacheKey = JSON.stringify([cfg.baseUrl, cfg.model, selectedVoice, apiLanguage, input]);
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = synthesizeScript(input, {
    ...cfg,
    voice: selectedVoice,
    language: apiLanguage,
  }, fetchImpl).then((result) => {
    audioCache.set(cacheKey, result);
    while (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value);
    return result;
  }).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  return request;
}

async function synthesizeScript(input, cfg, fetchImpl) {
  DELIVERY_CUE_PATTERN.lastIndex = 0;
  const hasDeliveryCue = DELIVERY_CUE_PATTERN.test(input);
  DELIVERY_CUE_PATTERN.lastIndex = 0;
  if (!hasDeliveryCue) return synthesizeUncached(input, cfg, fetchImpl);
  const segments = parseDeliveryScript(input);
  const rendered = [];
  let format = null;
  let requestId = null;
  for (const segment of segments) {
    if (segment.type === "pause") {
      const bytesPerSecond = format?.byteRate || 48000;
      rendered.push(Buffer.alloc(Math.round(bytesPerSecond * segment.durationMs / 1000)));
      continue;
    }
    const result = await synthesizeUncached(segment.text, { ...cfg, style: segment.style }, fetchImpl);
    const parsed = parsePcmWav(result.bytes);
    if (!parsed) {
      const error = new Error("Indic-Speak returned WAV audio that could not be joined safely.");
      error.code = "VOICE_UPSTREAM_INVALID_AUDIO";
      throw error;
    }
    format ||= parsed.format;
    rendered.push(parsed.pcm);
    requestId ||= result.requestId;
  }
  if (!format || !rendered.length) {
    const error = new Error("The delivery script did not contain any speakable text.");
    error.code = "INVALID_INPUT";
    throw error;
  }
  return { bytes: buildPcmWav(Buffer.concat(rendered), format), contentType: "audio/wav", provider: "indic-speak", requestId };
}

async function synthesizeUncached(input, cfg, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        input,
        voice: cfg.voice,
        instructions: JSON.stringify({ lang: cfg.language, ...(cfg.style ? { style: cfg.style } : {}) }),
      }),
    });
    if (!response.ok) {
      const error = new Error(`Indic-Speak returned HTTP ${response.status}.`);
      error.code = response.status === 401 || response.status === 403 ? "VOICE_AUTH_FAILED" : "VOICE_UPSTREAM_ERROR";
      throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
      const error = new Error("Indic-Speak returned invalid WAV audio.");
      error.code = "VOICE_UPSTREAM_INVALID_AUDIO";
      throw error;
    }
    lastSuccessfulAt = new Date().toISOString();
    console.log(`[Indic-Speak TTS] synthesized ${bytes.length} WAV bytes`);
    return { bytes, contentType: "audio/wav", provider: "indic-speak", requestId: response.headers.get("x-request-id") || null };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("Indic-Speak took too long to prepare the question.");
      timeout.code = "VOICE_UPSTREAM_TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VOICE_OPTIONS, config, health, parseDeliveryScript, synthesize };
