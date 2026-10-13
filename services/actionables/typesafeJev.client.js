"use strict";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function typesafeJevConfig(env = process.env) {
  const mode = String(env.TYPESAFE_JEV_ACTIONABLES_MODE || "shadow").trim().toLowerCase();
  return {
    enabled: String(env.TYPESAFE_JEV_ACTIONABLES_ENABLED || "").trim().toLowerCase() === "true",
    mode: mode === "active" ? "active" : "shadow",
    apiKey: String(env.TYPESAFE_API_KEY || "").trim(),
    endpoint: String(env.TYPESAFE_JEV_API_URL || DEFAULT_ENDPOINT).trim(),
    model: String(env.TYPESAFE_JEV_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: boundedNumber(env.TYPESAFE_JEV_TIMEOUT_MS, 1800, 100, 10_000),
    minConfidence: boundedNumber(env.TYPESAFE_JEV_MIN_CONFIDENCE, 0.65, 0, 1),
  };
}

function validateEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TYPESAFE_JEV_API_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("TypeSafe Jev endpoint must use HTTPS");
  return url.toString();
}

async function systemOne(request, { config = typesafeJevConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!config.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(validateEndpoint(config.endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...request, model: config.model }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = new Error(`TypeSafe Jev returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`TypeSafe Jev timed out after ${config.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  typesafeJevConfig,
  validateEndpoint,
  systemOne,
};
