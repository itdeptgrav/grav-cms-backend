const { cfg, isOpenWaActive } = require("../config/whatsappProvider");

class OpenWaError extends Error {
  constructor(message, status = 502, code = "openwa_error") {
    super(message);
    this.name = "OpenWaError";
    this.status = status;
    this.code = code;
  }
}

const headers = () => ({
  "Content-Type": "application/json",
  ...(cfg.openwaApiKey ? { "X-API-Key": cfg.openwaApiKey } : {}),
});

async function request(path, options = {}) {
  if (!isOpenWaActive()) {
    throw new OpenWaError("OpenWA is dormant because another WhatsApp provider is selected.", 503, "provider_dormant");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const response = await fetch(`${cfg.openwaBaseUrl}${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false || data?.error) {
      const detail = data?.error?.message || data?.error || data?.message;
      throw new OpenWaError(detail || `OpenWA request failed (HTTP ${response.status}).`, response.status === 401 ? 503 : 502);
    }
    return data;
  } catch (error) {
    if (error instanceof OpenWaError) throw error;
    if (error?.name === "AbortError") {
      throw new OpenWaError("OpenWA did not respond before the timeout.", 504, "openwa_timeout");
    }
    throw new OpenWaError(`OpenWA is unavailable: ${error.message}`, 503, "openwa_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

async function downloadMedia(messageId) {
  if (!isOpenWaActive()) {
    throw new OpenWaError("OpenWA is dormant because another WhatsApp provider is selected.", 503, "provider_dormant");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const response = await fetch(`${cfg.openwaBaseUrl}/api/media/${encodeURIComponent(messageId)}`, {
      headers: cfg.openwaApiKey ? { "X-API-Key": cfg.openwaApiKey } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new OpenWaError(data?.error || data?.message || `OpenWA media download failed (HTTP ${response.status}).`, response.status === 404 ? 404 : 502, "openwa_media_error");
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") || "application/octet-stream",
    };
  } catch (error) {
    if (error instanceof OpenWaError) throw error;
    if (error?.name === "AbortError") throw new OpenWaError("OpenWA media download timed out.", 504, "openwa_timeout");
    throw new OpenWaError(`OpenWA media is unavailable: ${error.message}`, 503, "openwa_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

const recipientDigitsFor = (waId) => {
  const digits = String(waId || "").replace(/\D/g, "");
  const countryCode = cfg.openwaDefaultCountryCode;
  if (!countryCode) return digits;
  if (digits.length === 10) return `${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `${countryCode}${digits.slice(1)}`;
  return digits;
};

const chatIdFor = (waId) => `${recipientDigitsFor(waId)}@c.us`;

async function sendText(waId, text) {
  // /api/sendText is supported by stable v4 and current v5 Easy API. Both
  // `content` (canonical argument name) and `text` (documented Easy API alias)
  // are sent so either runtime generation accepts the request.
  const response = await request("/api/sendText", {
    method: "POST",
    body: JSON.stringify({ to: chatIdFor(waId), content: text, text }),
  });
  return response?.data ?? response;
}

async function health() {
  const started = Date.now();
  try {
    const data = await request("/health", { method: "GET" });
    const session = data?.session || {};
    const explicitReady = session?.ready ?? data?.connected ?? data?.authenticated;
    const connected = explicitReady === true || (explicitReady == null && data?.status === "UP");
    return {
      live: connected,
      connected,
      sessionReady: session?.ready ?? data?.authenticated ?? connected,
      sessionId: data?.sessionId || session?.id || cfg.openwaSessionId,
      latencyMs: Date.now() - started,
      error: connected ? null : "OpenWA is running, but its WhatsApp session is not linked yet.",
    };
  } catch (error) {
    return {
      live: false,
      connected: false,
      sessionReady: false,
      sessionId: cfg.openwaSessionId,
      latencyMs: Date.now() - started,
      error: error.message,
    };
  }
}

module.exports = { OpenWaError, recipientDigitsFor, chatIdFor, sendText, downloadMedia, health, request };
