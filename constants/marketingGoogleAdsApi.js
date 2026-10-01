// constants/marketingGoogleAdsApi.js
//
// THE ONE PLACE THAT SAYS WHICH GOOGLE ADS API GRAV SPEAKS.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// The read client and the write bundle each carried their own `"v18"` and their
// own base URL. Google sunset v18, so every live call from both would have
// failed — and nothing would have caught it, because each file agreed with
// itself. One version, one base URL, derived here, and a test that fails if
// any other file builds a Google Ads URL.
//
// ── THE SUPPORTED SET IS EXPLICIT, AND THERE IS NO FALLBACK ────────────────
// Read from Google's "Deprecation and sunset" table on 2026-09-21. A version
// is usable only while its sunset month has not begun. A configured version
// outside this set, or past its sunset, is refused as a configuration
// problem — never quietly replaced with an older one, which is how a
// deployment ends up on a version nobody chose and Google has stopped serving.
"use strict";

const freeze = Object.freeze;

/* Google publishes sunset as a month. The version stops being usable on the
   first day of that month, which is the conservative reading. */
const VERSIONS = freeze({
  v22: freeze({ released: "2025-10-15", sunsetMonth: "2026-10", tentative: true }),
  v23: freeze({ released: "2026-01-28", sunsetMonth: "2027-02", tentative: false }),
  v24: freeze({ released: "2026-04-22", sunsetMonth: "2027-05", tentative: false }),
  v25: freeze({ released: "2026-07-22", sunsetMonth: "2027-08", tentative: false }),
});

/* ── THE SELECTED VERSION ───────────────────────────────────────────────────
   The newest stable major whose reference GRAV has read field by field
   (`docs/decisions/google-ads-api-v25.md`). Minor releases (v25.1, v25.2)
   are served under the same `/v25/` path and change nothing GRAV sends. */
const SELECTED_VERSION = "v25";

const API_HOST = "https://googleads.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/* Never selected: v18 is sunset. Listed so a test can prove it is absent from
   every executable Google client file, not merely from this one. */
const SUNSET_VERSIONS = freeze(["v17", "v18", "v19", "v20", "v21"]);

const sunsetStart = (version) => {
  const v = VERSIONS[version];
  return v ? new Date(`${v.sunsetMonth}-01T00:00:00Z`) : null;
};

/** Is this version one GRAV may call on this date? */
function isSupported(version, now = new Date()) {
  const start = sunsetStart(version);
  return Boolean(start) && now.getTime() < start.getTime();
}

/**
 * The version every Google Ads request uses.
 *
 * `GOOGLE_ADS_API_VERSION` exists for the upgrade itself — pointing one
 * environment at the next version before the code default moves — and it may
 * only name a version in the supported set. Anything else throws; nothing
 * falls back.
 */
function resolveVersion(env = process.env, now = new Date()) {
  const configured = String(env?.GOOGLE_ADS_API_VERSION ?? "").trim();
  const version = configured || SELECTED_VERSION;
  if (!isSupported(version, now)) {
    const err = new Error(`Google Ads API version ${version} is not supported by GRAV.`);
    err.code = "CHANNEL_API_VERSION_UNSUPPORTED";
    err.version = version;
    throw err;
  }
  return version;
}

/** The configured-or-selected version, without judging it. */
function resolveVersionSafe(env = process.env) {
  return String(env?.GOOGLE_ADS_API_VERSION ?? "").trim() || SELECTED_VERSION;
}

/** The base every Google Ads REST URL is built from. The only builder. */
function apiBase(env = process.env, now = new Date()) {
  return `${API_HOST}/${resolveVersion(env, now)}`;
}

/* ── GRAV'S OBJECT ROLES, IN GOOGLE'S WORDS ─────────────────────────────────
   GRAV's roles are provider-neutral and never appear in a Google query. An
   earlier read sent `FROM audience_group` and `FROM advertisement`, which are
   GRAV's words and not Google resources, so every delivery-state read would
   have been refused. This table is the only translation. */
const ROLE_TO_RESOURCE = freeze({
  budget: "campaign_budget",
  campaign: "campaign",
  audience_group: "ad_group",
  advertisement: "ad_group_ad",
  targeting_term: "ad_group_criterion",
});

/* Which of those has a status that says whether anything is shown. A campaign
   budget has none: its `status` is ENABLED/REMOVED (whether the budget object
   exists), not delivery. Reported separately, never as "paused". */
const ROLE_HAS_DELIVERY_STATUS = freeze({
  budget: false,
  campaign: true,
  audience_group: true,
  advertisement: true,
  targeting_term: true,
});

/* ── AUTHENTICATION, AS OF 2026-09-21 ───────────────────────────────────────
   Google sunset developer tokens on 2026-09-09. Access is now granted to the
   Google Cloud project that owns the OAuth client; a developer-token header is
   "optional and ignored", and Google will reject it in a future major version.
   So GRAV sends: Authorization (OAuth access token) and, only when the bound
   account sits under a manager, login-customer-id. Nothing else. */
const REQUEST_HEADERS = freeze(["Authorization", "Content-Type", "login-customer-id"]);

/* Google's own search page size is fixed at 10,000 rows, and setting
   `pageSize` is refused with PAGE_SIZE_NOT_SUPPORTED. Bounded reads use a GAQL
   LIMIT instead. */
const SEARCH_PAGE_ROWS = 10000;

module.exports = freeze({
  VERSIONS,
  SELECTED_VERSION,
  SUNSET_VERSIONS,
  API_HOST,
  TOKEN_URL,
  isSupported,
  resolveVersion,
  resolveVersionSafe,
  apiBase,
  ROLE_TO_RESOURCE,
  ROLE_HAS_DELIVERY_STATUS,
  REQUEST_HEADERS,
  SEARCH_PAGE_ROWS,
});
