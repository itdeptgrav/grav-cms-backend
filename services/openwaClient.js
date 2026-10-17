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

// Pairing credentials are fetched only on demand by the authenticated Chat
// connection panel. They are never logged, persisted, or returned by the
// general status endpoint. OpenWA v5 exposes the latest QR at `/qr`; the
// normaliser also accepts the common JSON and image responses used by v4
// deployments with the QR surface enabled.
async function qrCode() {
  if (!isOpenWaActive()) {
    throw new OpenWaError("OpenWA is not the active WhatsApp provider.", 409, "provider_dormant");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const suffix = cfg.openwaSessionId ? `?sessionId=${encodeURIComponent(cfg.openwaSessionId)}` : "";
    const response = await fetch(`${cfg.openwaBaseUrl}/qr${suffix}`, {
      headers: cfg.openwaApiKey ? { "X-API-Key": cfg.openwaApiKey } : {},
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new OpenWaError(data?.error || data?.message || `OpenWA QR request failed (HTTP ${response.status}).`, response.status === 404 ? 409 : 502, "openwa_qr_unavailable");
    }
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type.startsWith("image/")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 2 * 1024 * 1024) throw new OpenWaError("OpenWA returned an oversized QR image.", 502, "openwa_qr_invalid");
      return { image: `data:${type.split(";")[0]};base64,${buffer.toString("base64")}` };
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    const value = typeof data === "string"
      ? data
      : data?.qr || data?.data?.qr || data?.data || data?.image || data?.qrCode;
    if (!value || typeof value !== "string") {
      throw new OpenWaError("OpenWA has not generated a pairing QR yet.", 409, "openwa_qr_pending");
    }
    return value.startsWith("data:image/")
      ? { image: value }
      : { qr: value };
  } catch (error) {
    if (error instanceof OpenWaError) throw error;
    if (error?.name === "AbortError") throw new OpenWaError("OpenWA QR request timed out.", 504, "openwa_timeout");
    throw new OpenWaError(`OpenWA QR is unavailable: ${error.message}`, 503, "openwa_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { OpenWaError, recipientDigitsFor, chatIdFor, sendText, downloadMedia, health, qrCode, request };
