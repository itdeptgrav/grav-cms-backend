"use strict";

const crypto = require("crypto");

const baseUrl = () => String(process.env.GRAV_SPEECH_API_URL || "").replace(/\/$/, "");
const secret = () => String(process.env.GRAV_SPEECH_SHARED_SECRET || "");

function requestTimeoutMs() {
  const configured = Number(process.env.GRAV_SPEECH_REQUEST_TIMEOUT_MS || 120000);
  return Number.isFinite(configured) ? Math.min(300000, Math.max(1000, configured)) : 120000;
}

async function fetchWithTimeout(url, options, { fetchImpl = globalThis.fetch, timeoutMs = requestTimeoutMs() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("GRAV Speech request timed out while the model was unavailable or warming.");
      timeout.status = 504;
      timeout.code = "GRAV_SPEECH_TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function signature({ method, path, timestamp, service, companyId, body }) {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method.toUpperCase(), path, timestamp, service, companyId, digest].join("\n");
  return `v1=${crypto.createHmac("sha256", secret()).update(canonical).digest("hex")}`;
}

function headers({ method, path, service, companyId, body, contentType }) {
  if (!baseUrl() || !secret()) throw new Error("GRAV Speech API is not configured");
  if (!service || !companyId) throw new Error("Trusted service and company context are required");
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "Content-Type": contentType,
    "X-Grav-Timestamp": timestamp,
    "X-Grav-Service": service,
    "X-Grav-Company-Id": String(companyId),
    "X-Grav-Signature": signature({ method, path, timestamp, service, companyId: String(companyId), body }),
  };
}

async function request({ method, path, service, companyId, body = Buffer.alloc(0), contentType = "application/json" }) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const response = await fetchWithTimeout(`${baseUrl()}${path}`, {
    method,
    headers: headers({ method, path, service, companyId, body: payload, contentType }),
    body: method === "GET" ? undefined : payload,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`GRAV Speech request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.detail?.code || "GRAV_SPEECH_FAILED";
    throw error;
  }
  return data;
}

async function createTranscriptionJob({ service, companyId, source, diarization = false, idempotencyKey }) {
  const features = { diarization };
  const body = Buffer.from(JSON.stringify({ source, features, idempotencyKey }));
  return request({ method: "POST", path: "/v1/transcription-jobs", service, companyId, body });
}

async function getTranscriptionJob({ service, companyId, jobId }) {
  return request({ method: "GET", path: `/v1/transcription-jobs/${encodeURIComponent(jobId)}`, service, companyId });
}

async function cancelTranscriptionJob({ service, companyId, jobId }) {
  return request({ method: "POST", path: `/v1/transcription-jobs/${encodeURIComponent(jobId)}/cancel`, service, companyId });
}

async function transcribeUtterance({ service, companyId, audio, filename = "audio.webm" }) {
  const path = "/v1/utterances:transcribe";
  const body = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  const signed = headers({ method: "POST", path, service, companyId, body, contentType: "application/octet-stream" });
  const response = await fetchWithTimeout(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { ...signed, "X-Audio-Filename": filename.replace(/[\r\n]/g, "").slice(0, 180) },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`GRAV Speech request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.detail?.code || "GRAV_SPEECH_FAILED";
    throw error;
  }
  return data;
}

async function getReadiness({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!baseUrl() || !secret()) return { configured: false, ready: false, state: "not_configured" };
  try {
    const response = await fetchWithTimeout(`${baseUrl()}/health/ready`, { method: "GET" }, { fetchImpl, timeoutMs });
    const data = await response.json().catch(() => ({}));
    return {
      configured: true,
      ready: response.ok,
      state: response.ok ? "ready" : (data?.detail?.code || `http_${response.status}`),
    };
  } catch (error) {
    return { configured: true, ready: false, state: error?.code || "unreachable" };
  }
}

module.exports = {
  createTranscriptionJob,
  getTranscriptionJob,
  cancelTranscriptionJob,
  transcribeUtterance,
  getReadiness,
  _signature: signature,
  _fetchWithTimeout: fetchWithTimeout,
};
