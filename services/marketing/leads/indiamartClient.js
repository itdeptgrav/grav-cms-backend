// services/marketing/leads/indiamartClient.js
//
// ONE CALL TO INDIAMART'S PULL API, AND WHAT ITS ANSWER MEANS.
//
// ── THE KEY IS IN THE URL, SO THE URL NEVER LEAVES ─────────────────────────
// IndiaMART takes its key as a query parameter. The URL built here is handed
// to the transport and to nothing else: no error message, log line, stored
// field or response contains it. Every failure becomes one of GRAV's error
// codes (constants/marketingIndiamart.js ERRORS) with a fixed sentence; the
// source's own MESSAGE text is not repeated anywhere.
//
// ── THE TRANSPORT IS INJECTABLE ────────────────────────────────────────────
// `transport(url, { timeoutMs, maxBytes })` resolves to `{ status, text }`. The
// default speaks HTTPS; tests pass their own, so no test ever reaches IndiaMART.
"use strict";

const https = require("https");

const I = require("../../../constants/marketingIndiamart");

const str = (v) => String(v ?? "").trim();

class IndiamartError extends Error {
  constructor(code) {
    super(I.ERROR_BY_CODE[code]?.label || "IndiaMART check failed.");
    this.name = "IndiamartError";
    this.code = code;
  }
}

/* ── IST, AS INDIAMART WRITES IT ────────────────────────────────────────────
   The page's example is `07-Dec-202109:00:00`: day, month, year and time with
   no separator between year and hour. Computed as the codebase does everywhere
   else — shift by +5:30 and read the UTC fields. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const two = (n) => String(n).padStart(2, "0");

function formatIst(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
    + `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/* QUERY_TIME is IST. The page does not state its text format in words; the
   `YYYY-MM-DD HH:MM:SS` form is read, and anything else is kept as text with
   no date rather than guessed at. */
function parseIst(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(str(raw));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MS;
  const back = new Date(ms + IST_OFFSET_MS);
  /* Reject 2026-02-31 and the like rather than letting Date roll it over. */
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || h > 23 || mi > 59 || s > 59) return null;
  return new Date(ms);
}

function buildUrl(key, from, to) {
  const u = new URL(I.ENDPOINT);
  u.searchParams.set("glusr_crm_key", key);
  u.searchParams.set("start_time", formatIst(from));
  u.searchParams.set("end_time", formatIst(to));
  return u.toString();
}

/* ── THE DEFAULT TRANSPORT ──────────────────────────────────────────────── */
function httpsTransport(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => reject(new Error("response failed")));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    /* The driver's own error names the host and may echo the URL: dropped. */
    req.on("error", () => reject(new Error("unreachable")));
  });
}

/* ── READING THE ANSWER ─────────────────────────────────────────────────── */

function codeOf(body) {
  const n = Number(str(body?.CODE));
  return Number.isInteger(n) ? n : null;
}

/**
 * Interpret one Pull API answer.
 *
 * @returns {{ records: object[], empty: boolean }}  `empty` is IndiaMART's
 *   own statement that the window holds no enquiries (CODE 204)
 * @throws {IndiamartError}
 */
function interpret({ status, text }) {
  let body = null;
  try {
    body = JSON.parse(String(text ?? ""));
  } catch (_) {
    body = null;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    /* No readable body. The HTTP status alone can still say what happened. */
    const http = Number(status);
    if (http === 401 || http === 403) throw new IndiamartError("key_rejected");
    if (http === 429) throw new IndiamartError("rate_limited");
    if (http >= 500) throw new IndiamartError("provider_error");
    throw new IndiamartError("malformed_response");
  }

  const code = codeOf(body);
  if (code === 204) return { records: [], empty: true };
  if (code !== 200) {
    throw new IndiamartError(I.PROVIDER_CODE_TO_ERROR[code] || "malformed_response");
  }
  if (str(body.STATUS).toUpperCase() !== "SUCCESS" || !Array.isArray(body.RESPONSE)) {
    throw new IndiamartError("malformed_response");
  }

  /* A stated total larger than what arrived means the answer was cut short.
     The window is not covered until every enquiry in it is held. */
  const total = Number(str(body.TOTAL_RECORDS));
  if (str(body.TOTAL_RECORDS) !== "" && Number.isFinite(total) && total > body.RESPONSE.length) {
    throw new IndiamartError("incomplete_response");
  }
  return { records: body.RESPONSE, empty: body.RESPONSE.length === 0 };
}

/**
 * Fetch one window. One call, never retried here: IndiaMART's rate limit is
 * one call in five minutes, so a retry belongs to the next check.
 */
async function fetchWindow({ key, from, to, transport = httpsTransport }) {
  const url = buildUrl(key, from, to);
  let answer;
  try {
    answer = await transport(url, { timeoutMs: I.LIMITS.REQUEST_TIMEOUT_MS, maxBytes: I.LIMITS.MAX_RESPONSE_BYTES });
  } catch (_) {
    /* Timed out, refused, reset or too large. Whatever the cause, the error
       object may carry the URL — it goes no further than this line. */
    throw new IndiamartError("unreachable");
  }
  return interpret(answer || {});
}

module.exports = {
  fetchWindow,
  interpret,
  formatIst,
  parseIst,
  IndiamartError,
  __internals: { buildUrl, httpsTransport },
};
