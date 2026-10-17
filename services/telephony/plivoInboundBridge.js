"use strict";

const crypto = require("crypto");

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function liveKitSipEndpoint(env = process.env) {
  const explicit = String(env.GRAV_VOICE_LIVEKIT_SIP_ENDPOINT || "").trim();
  if (explicit) return explicit.replace(/^sips?:\/\//i, "").replace(/\/$/, "");

  const match = String(env.GRAV_VOICE_LIVEKIT_URL || env.LIVEKIT_URL || "").trim()
    .match(/^wss?:\/\/(?:meet-)?([a-z0-9-]+)\.livekit\.cloud\/?$/i);
  if (!match) return null;
  const region = String(env.GRAV_VOICE_LIVEKIT_SIP_REGION || "india").trim().toLowerCase();
  return `${match[1]}.${region}.sip.livekit.cloud`;
}

function liveKitSipUri(number, env = process.env) {
  const endpoint = liveKitSipEndpoint(env);
  if (!endpoint || !/^\+[1-9]\d{7,14}$/.test(String(number || ""))) return null;
  return `sip:${number}@${endpoint};transport=tcp`;
}

function configuredInboundNumber(value, env = process.env) {
  const normalize = (input) => {
    const raw = String(input || "").trim().replace(/[\s()-]/g, "");
    if (/^\d{10}$/.test(raw)) return `+91${raw}`;
    if (/^91\d{10}$/.test(raw)) return `+${raw}`;
    return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : null;
  };
  const requested = normalize(value);
  const configured = normalize(env.GRAV_VOICE_INBOUND_NUMBER || env.PLIVO_CALLER_ID);
  return requested && configured && requested === configured ? requested : null;
}

function dialXml({ number, actionUrl, env = process.env, timeout = 45 } = {}) {
  const sipUri = liveKitSipUri(number, env);
  if (!sipUri) return null;
  const seconds = Math.min(Math.max(Number(timeout) || 45, 5), 120);
  const action = actionUrl ? ` action="${xmlEscape(actionUrl)}" method="POST"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${seconds}"${action}><User>${xmlEscape(sipUri)}</User></Dial></Response>`;
}

function dialStatusUrl(req, env = process.env) {
  const answerUrl = publicRequestUrl(req, env);
  if (!answerUrl) return null;
  const url = new URL(answerUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/status`;
  url.search = "";
  return url.toString();
}

function publicRequestUrl(req, env = process.env) {
  const configuredBase = String(env.GRAV_VOICE_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configuredBase) return `${configuredBase}${req.originalUrl}`;
  const forwardedProtocol = String(req.get?.("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(req.get?.("x-forwarded-host") || "").split(",")[0].trim();
  const protocol = forwardedProtocol || req.protocol || "https";
  const host = forwardedHost || req.get?.("host");
  return host ? `${protocol}://${host}${req.originalUrl}` : null;
}

function signaturePayload(method, url, nonce, params = {}) {
  let assembled = String(url || "");
  if (String(method || "").toUpperCase() === "POST") {
    for (const key of Object.keys(params || {}).sort()) {
      const value = Array.isArray(params[key]) ? params[key].join("") : params[key];
      assembled += `${key}${value == null ? "" : String(value)}`;
    }
  }
  return `${assembled}${nonce || ""}`;
}

function constantTimeIncludes(actualHeader, expected) {
  return String(actualHeader || "").split(",").some((candidate) => {
    const actual = Buffer.from(candidate.trim());
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  });
}

function validV3Signature({ method, url, nonce, params, signature, authToken }) {
  if (!url || !nonce || !signature || !authToken) return false;
  const expected = crypto
    .createHmac("sha256", String(authToken))
    .update(signaturePayload(method, url, nonce, params))
    .digest("base64");
  return constantTimeIncludes(signature, expected);
}

function validPlivoRequest(req, env = process.env) {
  const token = String(env.PLIVO_AUTH_TOKEN || "").trim();
  if (!token) return env.GRAV_VOICE_PLIVO_REQUIRE_SIGNATURE !== "1";
  const nonce = req.get("x-plivo-signature-v3-nonce");
  const candidates = [req.get("x-plivo-signature-v3"), req.get("x-plivo-signature-ma-v3")].filter(Boolean);
  return candidates.some((signature) => validV3Signature({
    method: req.method,
    url: publicRequestUrl(req, env),
    nonce,
    params: req.method === "POST" ? req.body : {},
    signature,
    authToken: token,
  }));
}

module.exports = {
  configuredInboundNumber,
  dialXml,
  dialStatusUrl,
  liveKitSipEndpoint,
  liveKitSipUri,
  publicRequestUrl,
  signaturePayload,
  validPlivoRequest,
  validV3Signature,
  xmlEscape,
};
