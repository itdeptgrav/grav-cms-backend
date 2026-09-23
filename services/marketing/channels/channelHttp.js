// services/marketing/channels/channelHttp.js
//
// THE ONE PLACE AN ADVERTISING CHANNEL IS CONTACTED.
//
// ── WHY THE ADAPTERS SHARE THIS ────────────────────────────────────────────
// Three providers, three authentication schemes, three error shapes — and one
// set of rules that must hold identically for all of them: a bounded timeout, a
// small retry budget for reads only, rate limiting honoured rather than
// hammered, and a failure that stays a failure instead of decaying into an
// empty list. Written once because three copies would drift, and the copy that
// drifted would be the one that turned a 403 into zero spend.
//
// ── NO GENERIC REQUEST ESCAPES THIS MODULE ─────────────────────────────────
// `perform` takes a fully-formed request and is exported to the three adapters
// only. The adapters export named operations — `listCampaigns`, `campaignReport`
// — and no adapter exports anything that takes a caller's URL, method, path or
// query. A route therefore cannot reach an endpoint nobody allowed, and cannot
// reach a write verb at all: `assertReadOnly` refuses any method but GET and
// POST, and POST only where the provider's own READ API requires it (GAQL
// search, GA4 runReport), named explicitly at each call site.
"use strict";

const axios = require("axios");

const { fail } = require("../../storePurchase/errors");
const { CHANNEL_TIMEOUT_MS, CHANNEL_RETRIES } = require("../../../constants/marketingChannels");

const str = (v) => String(v ?? "").trim();

/* ── READS ONLY, AND "POST" IS NOT AN EXCEPTION TO THAT ─────────────────────
   Google Ads' reporting endpoint (`googleAds:searchStream`) and GA4's
   (`runReport`) are POSTs that read. Both are allowed here, and both are named
   by the adapter as `readIntent: true` at the call site, so the allowance is a
   statement about one endpoint rather than a hole the next contributor widens.

   Every other verb is refused in code, not by convention. This chunk performs
   no campaign mutation, and that claim is worth more if something enforces it. */
const READ_METHODS = new Set(["GET", "POST"]);

function assertReadOnly({ method, readIntent, operation }) {
  const verb = str(method).toUpperCase();
  if (!READ_METHODS.has(verb)) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "GRAV does not change anything in an advertising channel.",
      { operation, method: verb });
  }
  if (verb === "POST" && readIntent !== true) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "GRAV does not change anything in an advertising channel.",
      { operation, method: verb });
  }
}

/* ── AND THE ONE DELIBERATE HOLE, NAMED SEPARATELY ──────────────────────────
   The read chunk shipped with `assertReadOnly` and the promise that widening it
   would take three deliberate acts: a new route, a new adapter operation, and a
   change to this assertion. This IS that third act, and it is a second function
   rather than a parameter on the first.

   Why a second function: `assertReadOnly({ method: "POST", readIntent: true })`
   already passes, so adding a `mutationIntent` flag beside `readIntent` would
   put the write allowance one typo away from every read call site in three
   adapters. A caller reaching `assertMutation` has imported a differently-named
   function on purpose.

   It grants nothing by itself. `googleSearchBundle.js` is the only file that
   sets `mutationIntent`, it reaches exactly one endpoint, and the assertions
   there are the ones that say no operation it builds can change or start
   anything. */
function assertMutation({ method, mutationIntent, operation }) {
  if (mutationIntent !== true) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "GRAV does not change anything in an advertising channel.",
      { operation, method: str(method).toUpperCase() });
  }
  if (str(method).toUpperCase() !== "POST") {
    /* Google Ads mutates by POSTing to a `:mutate` endpoint. A DELETE or a PUT
       would be a different API than the one this was written against, and
       accepting one here would mean a URL somebody built by hand. */
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "That is not how GRAV changes anything in an advertising channel.",
      { operation, method: str(method).toUpperCase() });
  }
}

/* ── STATUS → GRAV FAILURE ──────────────────────────────────────────────────
   One table for all three providers. The provider's own body never travels: it
   is logged with the real status and the operation, and the caller gets a
   GRAV-owned code.

   401 and 403 are both `access_refused`. They differ upstream — one is an
   invalid token, the other a valid token without a permission — and the fix for
   both is the same human action, so the distinction belongs in the admin
   diagnostic and the log, not in the public code. */
function failForStatus(status, { channel, operation }) {
  if (status === 401 || status === 403) {
    return fail("CHANNEL_ACCESS_REFUSED",
      "The advertising channel declined GRAV's access. Somebody needs to review the connection.",
      { channel, operation });
  }
  if (status === 429) {
    return fail("CHANNEL_RATE_LIMITED",
      "The advertising channel asked GRAV to slow down. Nothing was read.",
      { channel, operation });
  }
  if (status === 400 || status === 404 || status === 422) {
    /* A bad request to a closed operation table is a GRAV bug or a provider API
       change, not a caller's mistake — the caller cannot choose the URL. Read as
       malformed so it surfaces as something to investigate rather than as a
       transient outage somebody waits out for a week. */
    return fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel did not accept GRAV's read. Nothing was read.",
      { channel, operation, status });
  }
  return fail("CHANNEL_UNAVAILABLE",
    "The advertising channel did not answer. This is not an empty result — nothing could be read.",
    { channel, operation });
}

/* Retry only what retrying can fix. A 403 retried is a 403 twice, and a 429
   retried immediately is how an account gets throttled harder. */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRYABLE_CODE = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH"]);

/* Deterministic, so a test can assert the schedule and an operator reading a log
   can tell a retry from a second request. No jitter: this is one screen's read,
   not a fleet of workers synchronising. */
const backoffMs = (attempt) => 250 * attempt;

/* A provider URL must never appear in a public response, and must appear in the
   log — an operator cannot diagnose a read they cannot locate. Query strings are
   dropped because Meta puts the access token in one. */
const safeUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[unparseable url]";
  }
};

/**
 * Perform one provider read.
 *
 * @param {object} req
 * @param {string} req.channel     which channel, for the log and the failure
 * @param {string} req.operation   the named operation, for the log
 * @param {boolean} [req.readIntent] true for a POST that reads
 * @returns {Promise<{status:number, data:any}>}
 */
async function perform({
  channel, operation, method = "GET", url, params, data, headers,
  readIntent = false, mutationIntent = false,
  timeoutMs = CHANNEL_TIMEOUT_MS, retries = CHANNEL_RETRIES,
  /* Optional: a provider-specific reader of a non-2xx body, returning a GRAV
     failure or null. Lets a provider whose refusals carry a structured reason
     (Google Ads' GoogleAdsFailure) say WHICH access problem it is, without the
     generic mapping below having to know any provider's taxonomy. */
  classify = null,
}) {
  /* One of the two gates, never neither. `mutationIntent` is not a default the
     way `readIntent` is: a call site that does not name it is a read. */
  if (mutationIntent === true) assertMutation({ method, mutationIntent, operation });
  else assertReadOnly({ method, readIntent, operation });

  let lastStatus = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const res = await axios({
        method, url, params, data,
        headers: { Accept: "application/json", ...(headers || {}) },
        timeout: timeoutMs,
        /* Every status is returned rather than thrown, so one code path handles
           them all. With axios's default, a 403 arrives as an exception and a
           200 as a value, and the retry logic then has to reason about an
           authorisation refusal in the same branch as a socket error. */
        validateStatus: () => true,
        /* A redirect from an API endpoint is not something to follow. Both
           providers answer directly; a 3xx here means GRAV is talking to
           something else, and following it would send the credential along. */
        maxRedirects: 0,
        /* So a timeout arrives as ETIMEDOUT rather than ECONNABORTED, which is
           what the retryable-code set below is written against. */
        transitional: { clarifyTimeoutError: true },
      });

      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, data: res.data };
      }

      lastStatus = res.status;
      if (typeof classify === "function") {
        const specific = classify(res.status, res.data, { operation });
        if (specific) throw specific;
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt > retries) {
        console.error(`[marketing-channel] ${channel} ${operation} ${method} ${safeUrl(url)} → ${res.status}`);
        throw failForStatus(res.status, { channel, operation });
      }
    } catch (err) {
      /* A GRAV failure thrown just above is the answer, not something to retry
         into. Anything else is a transport fault. */
      if (err?.name === "StorePurchaseError") throw err;

      lastErr = err;
      const code = str(err?.code) || (str(err?.message).includes("timeout") ? "ETIMEDOUT" : "");
      if (!RETRYABLE_CODE.has(code) || attempt > retries) {
        console.error(`[marketing-channel] ${channel} ${operation} ${method} ${safeUrl(url)} failed after ${attempt} attempt(s):`,
          code || str(err?.message).slice(0, 200));
        throw fail("CHANNEL_UNAVAILABLE",
          "The advertising channel did not answer. This is not an empty result — nothing could be read.",
          { channel, operation });
      }
    }

    if (attempt <= retries) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }

  /* Unreachable: the loop either returns or throws. Present so a future edit to
     the bounds cannot fall out of it with an undefined result, which a caller
     would read as an empty answer. */
  console.error(`[marketing-channel] ${channel} ${operation} exhausted its attempts`,
    lastStatus || str(lastErr?.code));
  throw fail("CHANNEL_UNAVAILABLE",
    "The advertising channel did not answer. This is not an empty result — nothing could be read.",
    { channel, operation });
}

/** An object, or a malformed-response failure. Never an empty object. */
function requireObject(value, { channel, operation, what }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.error(`[marketing-channel] ${channel} ${operation}: ${what} was not an object`);
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel's answer could not be read. Nothing was read.",
      { channel, operation });
  }
  return value;
}

/**
 * An array, or a malformed-response failure.
 *
 * ── `absentMeansEmpty` IS REQUIRED, AND HAS NO DEFAULT ─────────────────────
 * It used to default to `true`, which meant every call site inherited "a missing
 * collection key is an empty list" without anybody deciding that it was true for
 * that endpoint. It is true for some and false for others, and the difference is
 * the difference between "you have no campaigns" and "GRAV could not read your
 * campaigns" — the one distinction this whole contract exists to preserve.
 *
 * So each adapter states it per call, against the provider's documented empty
 * response, and omitting it is a programming error that throws here rather than
 * silently choosing the permissive answer.
 *
 *   Meta            `data` is ALWAYS present on a successful collection read,
 *                   as `[]` when empty. A 200 without it is not zero campaigns;
 *                   it is a response GRAV does not recognise.
 *   Google Ads REST `results` IS omitted when a page matched nothing — proto3
 *                   JSON drops an empty repeated field. Absent is genuinely empty.
 *   GA4 headers     `dimensionHeaders` and `metricHeaders` are mandatory and
 *                   describe the report's shape. Absent is malformed.
 *   GA4 rows        omitted when the report matched nothing. Absent is empty.
 */
function requireArray(container, key, { channel, operation, absentMeansEmpty }) {
  if (typeof absentMeansEmpty !== "boolean") {
    /* Not a provider failure — a GRAV one, and it must not be answerable with an
       empty list. */
    throw new Error(`requireArray(${key}) needs an explicit absentMeansEmpty for ${channel} ${operation}`);
  }

  const value = container?.[key];
  if (value === undefined || value === null) {
    if (absentMeansEmpty) return [];
    console.error(`[marketing-channel] ${channel} ${operation}: ${key} was absent, and this endpoint always sends it`);
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel's answer could not be read. Nothing was read.",
      { channel, operation });
  }
  if (!Array.isArray(value)) {
    console.error(`[marketing-channel] ${channel} ${operation}: ${key} was ${typeof value}, not an array`);
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel's answer could not be read. Nothing was read.",
      { channel, operation });
  }
  return value;
}

/**
 * Refuse a provider error envelope that arrived with a success status.
 *
 * ── A 200 IS NOT A SUCCESS ─────────────────────────────────────────────────
 * Meta's Graph API answers some failures with HTTP 200 and an `error` object in
 * the body — a debug-token problem, certain permission cases, and anything
 * behind a proxy that rewrote the status. Google's REST endpoints do the same
 * for a batch that partially failed.
 *
 * Without this check, that body reaches `requireArray`, has no `data` key, and
 * becomes an empty list: a permission failure rendered as "you have no
 * campaigns". This is the exact path the status-code mapping does not cover,
 * because there was no error status to map.
 */
function assertNoErrorEnvelope(data, { channel, operation }) {
  const envelope = data?.error;
  if (!envelope) return data;

  /* Logged with the provider's own words, which an operator needs and a caller
     must never see. */
  const detail = typeof envelope === "object"
    ? `${str(envelope.code) || "?"} ${str(envelope.type) || ""} ${str(envelope.message).slice(0, 200)}`
    : str(envelope).slice(0, 200);
  console.error(`[marketing-channel] ${channel} ${operation}: error envelope in a 2xx body: ${detail}`);

  /* Mapped by the provider's own classification where it is unambiguous, so a
     permission problem delivered with a 200 still reads as access refused
     rather than as a transient outage somebody waits out. */
  const type = typeof envelope === "object" ? str(envelope.type) : "";
  const code = typeof envelope === "object" ? Number(envelope.code) : NaN;
  if (/OAuth/i.test(type) || code === 190 || code === 200 || code === 10) {
    throw fail("CHANNEL_ACCESS_REFUSED",
      "The advertising channel declined GRAV's access. Somebody needs to review the connection.",
      { channel, operation });
  }
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    throw fail("CHANNEL_RATE_LIMITED",
      "The advertising channel asked GRAV to slow down. Nothing was read.",
      { channel, operation });
  }

  throw fail("CHANNEL_MALFORMED_RESPONSE",
    "The advertising channel reported a problem GRAV could not act on. Nothing was read.",
    { channel, operation });
}

module.exports = {
  perform, failForStatus, requireObject, requireArray, assertNoErrorEnvelope,
  safeUrl, backoffMs, assertReadOnly, assertMutation,
};
