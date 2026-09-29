// services/marketing/channels/googleAdsErrors.js
//
// READING GOOGLE'S REFUSAL, SO THE RIGHT PERSON FIXES THE RIGHT THING.
//
// Google Ads returns a `GoogleAdsFailure` inside the error body:
//
//   { "error": { "code": 403, "status": "PERMISSION_DENIED", "details": [ {
//       "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
//       "errors": [ { "errorCode": { "authorizationError": "USER_PERMISSION_DENIED" } } ],
//       "requestId": "…" } ] } }
//
// The HTTP status alone cannot tell a revoked OAuth token from a Cloud project
// with no API access from a manager account that cannot reach the bound
// account — all arrive as 401 or 403. Each is fixed by somebody different in a
// different console, so they are separated here, by Google's own enum values
// (read from the v25 reference on 2026-09-21).
//
// The provider's words go to the server log by enum name only — never the
// message, which can name accounts. The caller gets a GRAV code and sentence.
"use strict";

const { fail } = require("../../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const CHANNEL = "google_ads";

const OAUTH = new Set([
  "OAUTH_TOKEN_INVALID", "OAUTH_TOKEN_EXPIRED", "OAUTH_TOKEN_DISABLED",
  "OAUTH_TOKEN_REVOKED", "OAUTH_TOKEN_HEADER_INVALID", "GOOGLE_ACCOUNT_AUTHENTICATION_FAILED",
  "GOOGLE_ACCOUNT_DELETED", "AUTHENTICATION_ERROR", "TWO_STEP_VERIFICATION_NOT_ENROLLED",
  "ADVANCED_PROTECTION_NOT_ENROLLED",
]);

/* The Cloud-project access model that replaced developer tokens, plus the
   developer-token values Google still defines for older projects. */
const API_ACCESS = new Set([
  "PROJECT_DISABLED", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", "CLOUD_PROJECT_NOT_UNDER_ORGANIZATION",
  "DEVELOPER_TOKEN_NOT_APPROVED", "DEVELOPER_TOKEN_NOT_ON_ALLOWLIST", "DEVELOPER_TOKEN_PROHIBITED",
  "DEVELOPER_TOKEN_INVALID", "ORGANIZATION_NOT_APPROVED", "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN",
  "ORGANIZATION_NOT_RECOGNIZED", "MISSING_TOS", "INCOMPLETE_SIGNUP", "SERVICE_ACCESS_DENIED",
]);

const ACCOUNT_BINDING = new Set([
  "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION", "CUSTOMER_NOT_FOUND",
  "CUSTOMER_NOT_ENABLED", "CLIENT_CUSTOMER_ID_INVALID", "ACCESS_DENIED_FOR_ACCOUNT_TYPE",
]);

const PERMISSION = new Set([
  "USER_PERMISSION_DENIED", "ACTION_NOT_PERMITTED", "ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT",
  "NOT_ADS_USER", "METRIC_ACCESS_DENIED", "AUTHORIZATION_ERROR",
]);

/* Every `errorCode` value in the body, as `family:VALUE`. */
function errorCodesOf(data) {
  const root = data?.error && typeof data.error === "object" ? data.error : data;
  const details = Array.isArray(root?.details) ? root.details : [];
  const out = [];
  for (const d of details) {
    if (!/GoogleAdsFailure$/.test(str(d?.["@type"]))) continue;
    for (const e of Array.isArray(d.errors) ? d.errors : []) {
      for (const [family, value] of Object.entries(e?.errorCode || {})) {
        out.push({ family: str(family), value: str(value) });
      }
    }
  }
  return out;
}

const MESSAGES = {
  CHANNEL_OAUTH_UNAVAILABLE:
    "Google Ads declined GRAV's sign-in. An administrator needs to reconnect the Google account GRAV uses.",
  CHANNEL_API_ACCESS_UNAVAILABLE:
    "The Google Cloud project GRAV signs in through does not have Google Ads API access. An administrator needs to grant it in Google Cloud.",
  CHANNEL_ACCOUNT_BINDING_UNAVAILABLE:
    "The bound Google Ads account cannot be reached through the configured manager account. An administrator needs to review the account binding.",
  CHANNEL_ACCESS_REFUSED:
    "Google Ads declined GRAV's access to that account. Somebody needs to review the connection.",
  CHANNEL_API_VERSION_REJECTED:
    "Google Ads did not accept the API version GRAV uses. A GRAV update is needed.",
};

/**
 * A GRAV failure for a non-2xx Google Ads answer, or null to let the generic
 * status mapping decide.
 */
function classify(status, data, { operation } = {}) {
  const codes = errorCodesOf(data);
  const values = codes.map((c) => c.value);
  const pick = (code) => {
    console.error(`[marketing-channel] ${CHANNEL} ${operation || "?"} → ${status} ${codes.map((c) => `${c.family}:${c.value}`).join(",") || "(no GoogleAdsFailure)"}`);
    return fail(code, MESSAGES[code], { channel: CHANNEL, operation });
  };

  if (values.some((v) => OAUTH.has(v))) return pick("CHANNEL_OAUTH_UNAVAILABLE");
  if (values.some((v) => API_ACCESS.has(v))) return pick("CHANNEL_API_ACCESS_UNAVAILABLE");
  if (values.some((v) => ACCOUNT_BINDING.has(v))) return pick("CHANNEL_ACCOUNT_BINDING_UNAVAILABLE");
  if (values.some((v) => PERMISSION.has(v))) return pick("CHANNEL_ACCESS_REFUSED");
  if (values.includes("PAGE_SIZE_NOT_SUPPORTED")) {
    /* GRAV sent a field this version removed: a GRAV bug against the current
       contract, reported as such rather than as a permission problem. */
    return pick("CHANNEL_API_VERSION_REJECTED");
  }

  /* ── A VERSION GOOGLE NO LONGER SERVES ──────────────────────────────────
     Google does not document the exact response for a sunset version. A 404
     from a fixed Google Ads endpoint carrying no GoogleAdsFailure is not a
     missing resource — every GRAV read addresses an account, and an unknown
     account is a GoogleAdsFailure — so it is read as the path itself being
     gone, which is what a sunset version is. Inference, labelled as such. */
  if (status === 404 && !codes.length) return pick("CHANNEL_API_VERSION_REJECTED");

  return null;
}

/* ── THE TOKEN ENDPOINT SPEAKS OAUTH, NOT GOOGLE ADS ────────────────────────
   `invalid_grant` is a revoked or expired refresh token; `invalid_client` is a
   wrong client id or secret. Both are the OAuth credential, and neither is
   fixed by waiting. */
function classifyTokenFailure(status, data) {
  const code = str(data?.error);
  if (status === 400 || status === 401 || code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
    console.error(`[marketing-channel] ${CHANNEL} oauth.refresh → ${status} ${code || "(no code)"}`);
    return fail("CHANNEL_OAUTH_UNAVAILABLE", MESSAGES.CHANNEL_OAUTH_UNAVAILABLE, { channel: CHANNEL, operation: "oauth.refresh" });
  }
  return null;
}

/**
 * The Google Ads base URL for this environment, or a GRAV failure.
 *
 * Both Google clients build every URL through this, so a configured version
 * GRAV does not support stops every request with one code, before anything is
 * sent, rather than being replaced with an older one.
 */
function versionedBase(env = process.env) {
  // eslint-disable-next-line global-require
  const googleApi = require("../../../constants/marketingGoogleAdsApi");
  try {
    return googleApi.apiBase(env);
  } catch (err) {
    console.error(`[marketing-channel] ${CHANNEL} refused to call unsupported API version ${str(err?.version) || "?"}`);
    throw fail("CHANNEL_API_VERSION_REJECTED",
      "GRAV is configured for a Google Ads API version it does not support. An administrator needs to correct the configuration.",
      { channel: CHANNEL });
  }
}

module.exports = { classify, classifyTokenFailure, errorCodesOf, versionedBase, MESSAGES };
