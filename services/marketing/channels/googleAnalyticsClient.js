// services/marketing/channels/googleAnalyticsClient.js
//
// GOOGLE ANALYTICS 4, AS A MEASUREMENT SOURCE AND NOTHING ELSE.
//
// ── GA4 IS NOT A FOURTH ADVERTISING CHANNEL ────────────────────────────────
// A GA4 property has rows keyed by `sessionCampaignName`, and they look enough
// like a campaign list to be used as one. They are not one. Those rows are
// campaigns a browser told GA4 about — so a campaign that ran and got no tracked
// traffic is simply absent, and a campaign name somebody typed into a URL by
// hand is present. Presenting that as an inventory would mean a marketer's
// campaign list quietly omits their worst-performing campaigns.
//
// So this adapter has no `listCampaigns`. `constants/marketingChannels.js`
// records `campaigns: false` for the channel, the inventory service refuses the
// operation by name, and the refusal says why.
//
//   verifyProperty()      can GRAV read the configured property
//   campaignReport({ … }) sessions and conversions by campaign, for a range
//
// ── AND ITS NUMBERS ARE LABELLED DIFFERENTLY ───────────────────────────────
// GA4 counts sessions in a browser after consent, cookie policy and ad blockers
// have taken their share. Google Ads counts clicks it billed for. The two never
// agree, and a screen that shows them as one number invites somebody to
// reconcile figures that cannot be reconciled. Everything from here is published
// as `analytics_reported`.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const http = require("./channelHttp");
const secrets = require("./channelSecrets");

const CHANNEL = "google_analytics";
const API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const str = (v) => String(v ?? "").trim();

const { assertCalendarDate } = require("./channelDates");

/* The shared strict validator, not a shape check. */
const assertDate = (value, field) => assertCalendarDate(value, field);

/* The read-only analytics scope. Requesting `analytics.edit` would grant this
   deployment the ability to change a property's configuration, which nothing
   here does and nothing here should be able to do. */
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const tokenCache = new Map();
const fingerprint = (value) =>
  crypto.createHash("sha256").update(str(value)).digest("hex").slice(0, 16);

/* ── A SERVICE ACCOUNT SIGNS ITS OWN ASSERTION ──────────────────────────────
   The JWT-bearer flow: build a claim, sign it with the service account's private
   key, exchange it for an access token. Written out rather than pulled from
   `googleapis` because that library's auth object is a general-purpose client
   and holding one here would put an arbitrary-request capability inside an
   adapter whose whole purpose is not to have one. */
function serviceAccountAssertion(key) {
  let parsed;
  try {
    parsed = JSON.parse(key);
  } catch {
    /* The key is NOT included in the failure or the log. */
    throw fail("CHANNEL_NOT_CONFIGURED",
      "The analytics credentials in this deployment could not be read.",
      { channel: CHANNEL, missing: ["GA4_SERVICE_ACCOUNT_KEY"] });
  }

  const clientEmail = str(parsed.client_email);
  const privateKey = str(parsed.private_key).replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw fail("CHANNEL_NOT_CONFIGURED",
      "The analytics credentials in this deployment are incomplete.",
      { channel: CHANNEL, missing: ["GA4_SERVICE_ACCOUNT_KEY"] });
  }

  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claim = encode({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claim}`)
    .sign(privateKey)
    .toString("base64url");

  return `${header}.${claim}.${signature}`;
}

async function accessToken(creds) {
  /* Either flow, and which one is decided by what the deployment configured —
     never by a caller. */
  const useServiceAccount = Boolean(creds.serviceAccountKey);
  const key = fingerprint(useServiceAccount ? creds.serviceAccountKey : creds.refreshToken);

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = useServiceAccount
    ? new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(creds.serviceAccountKey),
    })
    : new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    });

  const { data } = await http.perform({
    channel: CHANNEL,
    operation: "oauth.token",
    method: "POST",
    readIntent: true,
    url: TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: body.toString(),
    retries: 0,
  });

  const token = str(data?.access_token);
  if (!token) {
    console.error(`[marketing-channel] ${CHANNEL} oauth.token returned no access token`);
    throw fail("CHANNEL_ACCESS_REFUSED",
      "Google Analytics declined GRAV's access. Somebody needs to review the connection.",
      { channel: CHANNEL });
  }

  const ttlMs = (Number(data?.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

/**
 * Can GRAV read the configured property?
 *
 * Reads the property's own metadata, which requires the same access a report
 * does and returns the property's timezone and currency — both of which a
 * reader needs in order to interpret every figure that follows.
 */
async function verifyProperty(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const operation = "property.verify";

  const { data } = await http.perform({
    channel: CHANNEL, operation, method: "GET",
    url: `${ADMIN_BASE}/properties/${encodeURIComponent(creds.propertyId)}`,
    headers: { Authorization: `Bearer ${token}` },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the property" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  return {
    propertyId: creds.propertyId,
    propertyName: str(data.displayName) || null,
    /* The property's OWN timezone. Every GA4 date range is interpreted in it,
       and a report read as though it were in the reader's timezone is off by up
       to a day at both ends. Published with every report for that reason. */
    timeZone: str(data.timeZone) || null,
    currency: str(data.currencyCode) || null,
  };
}

/**
 * Sessions and conversions by campaign, for one date range.
 *
 * ── AN EXPLICIT RANGE, ALWAYS ──────────────────────────────────────────────
 * GA4 accepts relative ranges like `28daysAgo`, which resolve against the
 * property's timezone at the moment of the call. Two identical requests minutes
 * apart can then cover different days, and a figure a marketer wrote down
 * yesterday cannot be reproduced. Only explicit dates are sent.
 */
async function campaignReport({ startDate, endDate, limit = 100, offset = 0 } = {}, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const operation = "campaign.report";

  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");

  const { data } = await http.perform({
    channel: CHANNEL, operation, method: "POST",
    /* `runReport` is a POST that reads. GA4 offers no GET equivalent. */
    readIntent: true,
    url: `${API_BASE}/properties/${encodeURIComponent(creds.propertyId)}:runReport`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: "sessionCampaignName" },
        { name: "sessionSource" },
        { name: "sessionMedium" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "conversions" },
      ],
      limit,
      offset,
      /* GA4 applies sampling and thresholding silently. Asking for the metadata
         is the only way to know a figure was withheld or estimated, and a
         withheld figure must not be published as a measured one. */
      returnPropertyQuota: false,
    },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the report" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });

  /* ── THE HEADERS ARE MANDATORY; THE ROWS ARE NOT ──────────────────────────
     GA4 describes a report's shape in `dimensionHeaders` and `metricHeaders`,
     and every successful `runReport` carries both — they are how a caller knows
     which column is which. A response without them is not an empty report; it is
     a body GRAV cannot interpret, and reading positionally from it would map
     sessions onto conversions.

     `rows` is different: a report that matched nothing omits it, so absent there
     is genuinely empty. */
  const headers = http.requireArray(data, "dimensionHeaders", { channel: CHANNEL, operation, absentMeansEmpty: false })
    .map((h) => str(h?.name));
  const metricHeaders = http.requireArray(data, "metricHeaders", { channel: CHANNEL, operation, absentMeansEmpty: false })
    .map((h) => str(h?.name));
  const rows = http.requireArray(data, "rows", { channel: CHANNEL, operation, absentMeansEmpty: true });

  const numeric = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const at = (list, name) => {
    const i = list.indexOf(name);
    return i === -1 ? null : i;
  };

  const campaignAt = at(headers, "sessionCampaignName");
  const sourceAt = at(headers, "sessionSource");
  const mediumAt = at(headers, "sessionMedium");
  const sessionsAt = at(metricHeaders, "sessions");
  const usersAt = at(metricHeaders, "totalUsers");
  const conversionsAt = at(metricHeaders, "conversions");

  return {
    propertyId: creds.propertyId,
    rows: rows.map((r) => ({
      campaignName: campaignAt === null ? null : str(r?.dimensionValues?.[campaignAt]?.value) || null,
      source: sourceAt === null ? null : str(r?.dimensionValues?.[sourceAt]?.value) || null,
      medium: mediumAt === null ? null : str(r?.dimensionValues?.[mediumAt]?.value) || null,
      sessions: sessionsAt === null ? null : numeric(r?.metricValues?.[sessionsAt]?.value),
      users: usersAt === null ? null : numeric(r?.metricValues?.[usersAt]?.value),
      conversions: conversionsAt === null ? null : numeric(r?.metricValues?.[conversionsAt]?.value),
    })),
    /* GA4's own count of matching rows, used to page. Absent is unknown. */
    totalRows: Number.isInteger(Number(data.rowCount)) ? Number(data.rowCount) : null,
    /* True when GA4 estimated rather than counted. A sampled figure is still
       worth showing and must never be shown as exact. */
    sampled: Array.isArray(data.metadata?.samplingMetadatas)
      && data.metadata.samplingMetadatas.length > 0,
  };
}

module.exports = {
  CHANNEL,
  verifyProperty,
  campaignReport,
  __test: { assertDate, serviceAccountAssertion, tokenCache },
};
