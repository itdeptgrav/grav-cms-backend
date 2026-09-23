// services/marketing/providerPrivacy.js
//
// THE MARKETING ENGINE IS AN IMPLEMENTATION DETAIL. THIS IS THE DOOR IT STOPS AT.
//
// ── WHY A BOUNDARY AND NOT A NAMING CONVENTION ─────────────────────────────
// GRAV's marketing automation runs on Mautic. That is true, it is documented
// honestly in `docs/decisions/architecture-decisions.md` and in the header of
// every file that talks to it, and a developer reading this repository needs to
// know it. A marketer reading a screen does not.
//
// The difference matters for reasons beyond branding. A provider name in a
// response teaches a client to special-case that provider, and the client then
// breaks when the provider is replaced. A provider URL tells a browser where the
// marketing platform lives. A raw upstream error quotes whatever the provider
// felt like saying, which has included a credential echoed back inside an OAuth
// error body. A provider-shaped error code makes the frontend depend on the
// provider's own vocabulary, which is precisely the coupling the anti-corruption
// layer exists to prevent.
//
// So every refusal that leaves a Marketing route passes through here. It arrives
// with the honest provider detail and leaves with a GRAV-owned code, a GRAV-owned
// sentence and nothing a reader could use to identify, reach or blame the
// engine. The honest version goes to the server log, where a technical operator
// can read it and a browser cannot.
//
// ── AND THE LOG IS NOT A DUMPING GROUND EITHER ─────────────────────────────
// `logProviderFailure` scrubs before it writes. A log line is read by more people
// than a response body and kept for longer, and "it is only the log" is how a
// credential ends up in a ticket.
"use strict";

const { CODES } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/* ── THE NAME GRAV USES ─────────────────────────────────────────────────────
   One term, everywhere a person can see it. "Marketing engine" rather than
   "marketing automation provider" because a marketer should not have to know
   that GRAV delegates this at all. */
const ENGINE_LABEL = "marketing engine";

/* ── WHAT A PROVIDER FAILURE IS CALLED IN PUBLIC ────────────────────────────
   Every provider-shaped code maps to one GRAV-owned code, and the mapping is
   deliberately LOSSY: "unreachable", "refused our credentials" and "answered
   something we could not parse" are three different things to an operator and
   one thing to a marketer — the engine is not answering and somebody technical
   needs to look. Splitting them in public would leak the provider's failure
   taxonomy without telling the reader anything they can act on.

   The distinctions survive in full in the log. */
const PUBLIC_CODE = Object.freeze({
  MAUTIC_UNAVAILABLE: "MARKETING_ENGINE_UNAVAILABLE",
  MAUTIC_AUTH_FAILED: "MARKETING_ENGINE_UNAVAILABLE",
  MAUTIC_MALFORMED_RESPONSE: "MARKETING_ENGINE_UNAVAILABLE",
  MAUTIC_NOT_CONFIGURED: "MARKETING_ENGINE_NOT_CONFIGURED",
  MAUTIC_REJECTED_WRITE: "MARKETING_ENGINE_REJECTED_REQUEST",
  MAUTIC_BAD_REQUEST: "MARKETING_ENGINE_REJECTED_REQUEST",
});

/* The sentence each public code carries. Written once, here, so two routes
   cannot describe the same failure two ways — and written for a marketer, which
   means it says what they can do rather than what broke. */
const PUBLIC_MESSAGE = Object.freeze({
  MARKETING_ENGINE_UNAVAILABLE:
    "The marketing engine is unavailable, so this could not be read. Nothing has been changed. Try again shortly; if it continues, it needs a technical operator.",
  MARKETING_ENGINE_NOT_CONFIGURED:
    "The marketing engine is not configured for this company yet, so there is nothing to read.",
  MARKETING_ENGINE_REJECTED_REQUEST:
    "The marketing engine refused this request. Nothing has been changed, and it needs a technical operator.",
});

/* ── THE SCRUBBER ───────────────────────────────────────────────────────────
   A second layer, not the first. The mapping above is what keeps the provider
   out of a response; this catches a sentence somebody writes next year without
   reading this file. It runs over every public message and every string in a
   sanitised detail.

   Ordered longest-first so a URL is replaced before the bare hostname inside
   it. */
const SCRUB_PATTERNS = Object.freeze([
  /* Any absolute URL. A response has no business carrying one, and an internal
     hostname is worth as much to an attacker as a version number. */
  [/\bhttps?:\/\/[^\s"'<>)]+/gi, "[internal endpoint]"],
  /* Provider API routes, with or without a host. */
  [/\/api\/(?:emails|forms|pages|contacts|segments|campaigns|fields|hooks|users|roles)[^\s"']*/gi, "[internal endpoint]"],
  [/\/oauth\/v2\/token/gi, "[internal endpoint]"],
  /* The provider's name, in any casing, including possessives. */
  [/\bmautic['’]s\b/gi, "the marketing engine's"],
  [/\bmautic\b/gi, "the marketing engine"],
  /* Credential and configuration variable names. Naming the variable tells a
     reader which secret to go looking for. */
  [/\bMAUTIC_[A-Z0-9_]+\b/g, "[internal setting]"],
  [/\bGATEWAY_[A-Z0-9_]+\b/g, "[internal setting]"],
  [/\bgrav-(?:integration|content-reader)\b/gi, "[internal account]"],
  /* Internal addresses. A loopback or private host in a message tells a reader
     where the platform runs, and `connect ECONNREFUSED 127.0.0.1:8088` is the
     commonest way that escapes. */
  [/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?/gi, "[internal address]"],
  /* Anything that looks like a bearer token or a basic credential. */
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/g, "[redacted]"],
]);

/** Remove every provider trace from one string. */
function scrubText(value) {
  let out = str(value);
  if (!out) return "";
  for (const [pattern, replacement] of SCRUB_PATTERNS) out = out.replace(pattern, replacement);
  /* Collapse the double article the name replacement can produce. */
  return out.replace(/\bthe the marketing engine\b/gi, "the marketing engine");
}

/* Detail keys that describe the PROVIDER rather than the caller's request.
   Dropped entirely: a reader cannot act on them and an attacker can. */
const PROVIDER_DETAIL_KEYS = new Set([
  "url", "status", "attempts", "cause", "errors", "sourceCode", "reason",
  "available", "expectedKey", "received", "hostname", "baseUrl", "segment",
  "segmentId", "campaignId", "contactId", "mauticContactId", "declared",
]);

/**
 * Keep only the parts of an error's details a caller can act on.
 *
 * `field` and `accepted` survive because they describe the REQUEST — a client
 * showing "that is not a valid limit, accepted 1 to 50" is helping. Everything
 * describing the provider is dropped rather than scrubbed, because a scrubbed
 * status code is still a status code.
 */
function sanitiseDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (PROVIDER_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string") { out[key] = scrubText(value); continue; }
    if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "string" ? scrubText(v) : v));
      continue;
    }
    if (value === null || typeof value !== "object") { out[key] = value; continue; }
    /* One level of nesting is plenty for a refusal; deeper is a payload, not a
       detail. */
    out[key] = sanitiseDetails(value);
  }
  return out;
}

/**
 * Is this a provider-shaped failure that must be translated?
 *
 * A GRAV-owned refusal — a validation error, a tenancy refusal — passes through
 * untouched except for the scrubber, because its message was written for the
 * caller in the first place.
 */
const isProviderFailure = (code) => Object.prototype.hasOwnProperty.call(PUBLIC_CODE, str(code));

/**
 * The public face of one error.
 *
 * @returns {{status:number, code:string, message:string, details:object}}
 */
function publicFace(err) {
  const originalCode = str(err?.code);

  if (isProviderFailure(originalCode)) {
    const code = PUBLIC_CODE[originalCode];
    return {
      /* The mapped code's own status, so a 503 stays retryable and a
         not-configured stays a 409 — the HTTP semantics a client acts on are
         preserved even though the vocabulary changed. */
      status: CODES[code]?.status || 503,
      code,
      /* A fixed GRAV sentence. The provider's own message is never the source. */
      message: PUBLIC_MESSAGE[code],
      details: sanitiseDetails(err?.details),
    };
  }

  return {
    status: Number(err?.status) || 500,
    code: originalCode || "INTERNAL",
    /* Scrubbed rather than replaced: this message was written for the caller,
       and the scrubber is only catching a provider name somebody let slip. */
    message: scrubText(err?.message) || "Something went wrong. Nothing was changed.",
    details: sanitiseDetails(err?.details),
  };
}

/* ── THE SERVER-SIDE RECORD ─────────────────────────────────────────────────
   Where the honest detail goes. A technical operator reading the application log
   gets the provider name, the route and the status; a browser gets none of it.

   Secrets are scrubbed even here. A log line outlives the request, is copied
   into tickets and is read by more people than a response body, and "it is only
   the log" is the sentence that precedes a credential in a chat thread. */
function logProviderFailure(err, context = {}) {
  const parts = [
    `[marketing:provider] ${str(context.operation) || "request"} failed`,
    `code=${str(err?.code) || "unknown"}`,
  ];
  if (context.kind) parts.push(`kind=${str(context.kind)}`);
  if (err?.details?.status) parts.push(`upstreamStatus=${err.details.status}`);
  if (err?.details?.url) parts.push(`upstreamPath=${str(err.details.url)}`);
  /* The message, with credentials removed but the provider name intact — this
     line is for somebody who needs to know which system failed. */
  const message = str(err?.message)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b(password|secret|token|client_secret)=\S+/gi, "$1=[redacted]")
    .slice(0, 500);
  parts.push(`message="${message}"`);
  console.error(parts.join(" "));
}

/**
 * Send one error from a Marketing route.
 *
 * Replaces `sendError` on every Marketing surface. A provider failure is logged
 * honestly and answered anonymously; a GRAV refusal is answered as written, with
 * the scrubber as a backstop.
 */
function sendMarketingError(res, err, context = {}) {
  if (isProviderFailure(err?.code)) logProviderFailure(err, context);
  else if (!err?.code) console.error("[marketing] unhandled error:", err);

  const face = publicFace(err);
  return res.status(face.status).json({
    success: false,
    error: { code: face.code, message: face.message, details: face.details },
    /* `message` at the top level too: every existing screen reads `body.message`,
       and the shared error shape this mirrors does the same. */
    message: face.message,
  });
}

/** Wrap an async Marketing route so a thrown refusal becomes a safe response. */
const handleMarketing = (context) => (fn) => (req, res, next) => Promise
  .resolve(fn(req, res, next))
  .catch((err) => sendMarketingError(res, err, { ...context, operation: `${req.method} ${req.path}` }));

/* ── THE PUBLIC NAME OF EACH INTERNAL REASON CODE ───────────────────────────
   `DELIVERY_REASONS` and the hold's `activeError.reasonCode` are how this
   codebase groups failures, and four of them carry the provider's name. They are
   an API contract for the Data Health screen, so they cannot simply be scrubbed
   into prose — they are mapped onto GRAV-owned codes that mean the same thing to
   the person reading the screen. */
const PUBLIC_REASON_CODE = Object.freeze({
  MAUTIC_UNREACHABLE: "MARKETING_ENGINE_UNREACHABLE",
  MAUTIC_AUTH_REFUSED: "MARKETING_ENGINE_REFUSED_CREDENTIALS",
  MAUTIC_NOT_CONFIGURED: "MARKETING_ENGINE_NOT_CONFIGURED",
  MAUTIC_WRITE_REJECTED: "MARKETING_ENGINE_REJECTED_REQUEST",
  MAUTIC_UNAVAILABLE: "MARKETING_ENGINE_UNREACHABLE",
  MAUTIC_AUTH_FAILED: "MARKETING_ENGINE_REFUSED_CREDENTIALS",
  MAUTIC_MALFORMED_RESPONSE: "MARKETING_ENGINE_UNREADABLE_RESPONSE",
  MAUTIC_REJECTED_WRITE: "MARKETING_ENGINE_REJECTED_REQUEST",
  MAUTIC_BAD_REQUEST: "MARKETING_ENGINE_REJECTED_REQUEST",
});

/** One internal reason code, as a reader sees it. Unmapped codes pass through:
 *  they are GRAV's own words already. */
const publicReasonCode = (code) => PUBLIC_REASON_CODE[str(code)] || str(code) || null;

/** A served vocabulary list, with provider-named codes renamed and provider
 *  names scrubbed from the labels. */
function publicVocabulary(entries) {
  return (entries || []).map((e) => {
    /* Some served tables are `{ code, label }` objects and some — the
       reconciliation categories among them — are bare strings. Spreading a
       string produces an object keyed by character position, which is a silent
       corruption of the response rather than a crash, so the shape is checked
       before it is destructured. */
    if (typeof e === "string") return publicReasonCode(e);
    if (!e || typeof e !== "object") return e;
    const out = { ...e, code: publicReasonCode(e.code) };
    /* The vocabulary helper names its human label `label`, and other tables in
       this codebase use `means` or `description`. Scrub whichever is present
       rather than assuming: a scrubber aimed at a field that does not exist is a
       scrubber that silently does nothing, which is how "Synchronized with
       Mautic" reached a screen. */
    for (const field of ["label", "means", "description"]) {
      if (typeof out[field] === "string") out[field] = scrubText(out[field]);
    }
    return out;
  });
}

/** The upstream code a provider failure was classified from, or null.
 *
 *  Translated when GRAV owns an equivalent, and DROPPED when it does not. The
 *  alternative — passing an unrecognised token through — is how a provider's
 *  vocabulary reaches a client one new error code at a time, and a client that
 *  sees it once will branch on it. */
function publicSourceCode(code) {
  const c = str(code);
  if (!c) return null;
  return PUBLIC_REASON_CODE[c] || null;
}

/** A per-kind or per-row failure reported INSIDE a 200 response. The route-level
 *  translation never sees these, so they are sanitised where they are built. */
function publicFailure({ reasonCode, reason } = {}) {
  return {
    reasonCode: publicReasonCode(reasonCode),
    reason: scrubText(reason) || null,
  };
}

module.exports = {
  ENGINE_LABEL,
  PUBLIC_REASON_CODE,
  publicReasonCode,
  publicSourceCode,
  publicVocabulary,
  publicFailure,
  PUBLIC_CODE,
  PUBLIC_MESSAGE,
  scrubText,
  sanitiseDetails,
  publicFace,
  isProviderFailure,
  logProviderFailure,
  sendMarketingError,
  handleMarketing,
};
