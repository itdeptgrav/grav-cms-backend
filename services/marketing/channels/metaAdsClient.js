// services/marketing/channels/metaAdsClient.js
//
// META ADS, AS A CLOSED SET OF FOUR READS.
//
// ── THE GRAPH API IS ONE ENDPOINT WITH A PATH PARAMETER ────────────────────
// Every Meta read is `GET /{version}/{node}/{edge}`, which means an adapter
// exposing `graph(path)` would expose the entire Graph API — including the edges
// that read people, custom audiences and payment methods, and including every
// POST that creates an advertisement. So the node and edge are chosen HERE, from
// constants, and the only caller-supplied value that ever reaches a path is a
// campaign id that has already been checked against `^\d+$`.
//
//   accessibleAccounts()      the ad accounts this token can see
//   verifyAccount()           can GRAV read the configured account
//   listCampaigns({ … })      one page of campaigns
//   campaignInsights({ … })   one campaign's metrics for a date range
//
// ── THE ACCESS TOKEN GOES IN A HEADER, NOT THE QUERY STRING ────────────────
// Meta's documentation puts `access_token` in the query string, and every
// example does the same. That would put a long-lived credential into GRAV's
// outbound request logs, any intermediary's access logs and any error message
// carrying a URL. Meta accepts a bearer header for the same call, so this uses
// one, and `channelHttp.safeUrl` strips query strings from log lines regardless.
//
// ── WHAT META REPORTS THAT GOOGLE DOES NOT, AND VICE VERSA ─────────────────
// Meta reports `reach` — people, not impressions — which Google Ads has no
// equivalent for. Meta's `actions` array carries conversions under dozens of
// action types that are not comparable with Google's `conversions`. Neither is
// reconciled here: the normalisation layer publishes each under its own channel
// with its own basis, and never adds them together.
"use strict";

const { fail } = require("../../storePurchase/errors");
const http = require("./channelHttp");
const secrets = require("./channelSecrets");

const CHANNEL = "meta_ads";
const API_VERSION = "v21.0";
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;

const str = (v) => String(v ?? "").trim();

const { assertCalendarDate } = require("./channelDates");

const assertDigits = (value, field) => {
  const v = str(value);
  if (!/^\d{1,20}$/.test(v)) {
    throw fail("VALIDATION", `${field} must be a whole number.`, { field });
  }
  return v;
};

/* The shared strict validator. Meta rejects an impossible date with a 400 that
   GRAV would surface as a malformed response, sending an operator to look for an
   API change that never happened. */
const assertDate = (value, field) => assertCalendarDate(value, field);

/* GRAV status → Meta's own filtering vocabulary. A closed map: a caller supplies
   a GRAV code and nothing a caller writes becomes a filter value. */
const STATUS_FILTER = Object.freeze({
  active: ["ACTIVE"],
  paused: ["PAUSED", "CAMPAIGN_PAUSED"],
  removed: ["DELETED", "ARCHIVED"],
});

/* ── THE FIELD LISTS ────────────────────────────────────────────────────────
   Narrow on purpose. Meta will return `promoted_object`, `adlabels`,
   `special_ad_categories` and more if asked, and several of those carry
   audience and targeting detail this chunk has no use for. */
const CAMPAIGN_FIELDS = [
  "id", "name", "objective", "status", "effective_status",
  "start_time", "stop_time", "daily_budget", "lifetime_budget", "updated_time",
].join(",");

const INSIGHT_FIELDS = [
  "campaign_id", "spend", "impressions", "reach", "clicks", "actions", "account_currency",
].join(",");

const ACCOUNT_FIELDS = ["id", "name", "currency", "account_status", "timezone_name"].join(",");

const authHeaders = (creds) => ({ Authorization: `Bearer ${creds.accessToken}` });

/** The ad accounts this token can see. Administrators only. */
async function accessibleAccounts(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "accounts.list";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/me/adaccounts`,
    headers: authHeaders(creds),
    params: { fields: ACCOUNT_FIELDS, limit: 50 },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  /* Meta ALWAYS sends `data` on a successful collection read, as `[]` when the
     collection is empty. A 200 without it is not "no accounts" — it is a body
     GRAV does not recognise, and calling it zero would render a permission
     problem as an empty estate. */
  return http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false }).map((a) => ({
    accountId: str(a?.id).replace(/^act_/, ""),
    accountName: str(a?.name) || null,
    currency: str(a?.currency) || null,
  }));
}

/** A real read of the configured account, not a ping. */
async function verifyAccount(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "account.verify";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/act_${creds.accountId}`,
    headers: authHeaders(creds),
    params: { fields: ACCOUNT_FIELDS },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the account" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  return {
    accountId: str(data.id).replace(/^act_/, "") || creds.accountId,
    accountName: str(data.name) || null,
    currency: str(data.currency) || null,
    timeZone: str(data.timezone_name) || null,
  };
}

/**
 * One page of campaigns.
 *
 * `pageToken` is Meta's own `after` cursor, carried opaquely. GRAV never
 * constructs one and never parses one; it is a value Meta issued, handed back
 * unaltered.
 */
async function listCampaigns({ status = null, pageToken = null, pageSize = 25 } = {}, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "campaigns.list";

  const params = { fields: CAMPAIGN_FIELDS, limit: pageSize };
  if (status) {
    const values = STATUS_FILTER[str(status)];
    if (!values) {
      throw fail("VALIDATION", "That is not a campaign status Meta Ads can be filtered by.", {
        field: "status", accepted: Object.keys(STATUS_FILTER),
      });
    }
    /* Meta's filtering grammar, built from the closed map above. The operator and
       the field are constants; only the mapped values vary. */
    params.filtering = JSON.stringify([
      { field: "effective_status", operator: "IN", value: values },
    ]);
  }
  if (pageToken) params.after = str(pageToken);

  const { data } = await http.perform({
    channel: CHANNEL, operation, method: "GET",
    url: `${API_BASE}/act_${creds.accountId}/campaigns`,
    headers: authHeaders(creds),
    params,
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  /* Present on every successful read, `[]` when empty. Absent is malformed. */
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  return {
    rows: rows.map((c) => ({
      providerCampaignId: str(c?.id),
      name: str(c?.name) || null,
      /* BOTH statuses. `status` is what somebody set; `effective_status` is what
         Meta is actually doing, and they disagree whenever a campaign is live
         but its parent account is stopped. Publishing only the first would show
         a marketer an active campaign that is delivering nothing. */
      providerStatus: str(c?.effective_status) || str(c?.status) || null,
      providerConfiguredStatus: str(c?.status) || null,
      objective: str(c?.objective) || null,
      startDate: str(c?.start_time) || null,
      endDate: str(c?.stop_time) || null,
      /* Meta sends budgets as minor units in a string — "5000" is 50.00 in a
         two-decimal currency. Carried as the string it was, and converted once
         in the normalisation layer where the currency is known. */
      dailyBudgetMinor: c?.daily_budget ?? null,
      lifetimeBudgetMinor: c?.lifetime_budget ?? null,
      currency: null,
      providerUpdatedAt: str(c?.updated_time) || null,
    })),
    /* Absent `after` means this is the last page. Meta also sends `paging.next`
       as a full URL with the token in it, which is deliberately not used. */
    nextPageToken: str(data?.paging?.cursors?.after) || null,
    /* Meta does not send a total unless asked with a summary parameter that
       changes the query's cost. Null, never a substituted page length. */
    totalResults: null,
  };
}

/**
 * Can GRAV read INSIGHTS, as opposed to campaign configuration?
 *
 * Meta separates these. `ads_read` covers the campaign edge; the insights edge
 * can be refused independently, and a token issued before an app review often
 * reads campaigns and nothing else. Inferring reporting from a successful
 * campaign list therefore reports a connection as healthy when every performance
 * read will fail.
 *
 * One day, one row, at account level: the smallest request that actually touches
 * the insights surface.
 */
async function verifyReporting(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "reporting.verify";
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const { data } = await http.perform({
    channel: CHANNEL, operation, method: "GET",
    url: `${API_BASE}/act_${creds.accountId}/insights`,
    headers: authHeaders(creds),
    params: {
      fields: "spend",
      time_range: JSON.stringify({ since: day, until: day }),
      level: "account",
      limit: 1,
    },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  /* The shape is checked, and an empty `data` is a success: an account that
     spent nothing yesterday can still be reported on. */
  http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });
  return true;
}

/**
 * One campaign's insights over an explicit date range.
 *
 * ── AN ABSENT METRIC IS ABSENT ─────────────────────────────────────────────
 * Meta omits a field entirely when it has no data for it, and sends numbers as
 * STRINGS. `numeric()` returns null for absent and for unparseable, and a real
 * number for "0" — so a campaign that genuinely spent nothing is distinguishable
 * from one whose spend Meta did not report.
 */
async function campaignInsights({ providerCampaignId, startDate, endDate }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "campaign.insights";

  const id = assertDigits(providerCampaignId, "campaignId");
  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");

  const { data } = await http.perform({
    channel: CHANNEL, operation, method: "GET",
    url: `${API_BASE}/${id}/insights`,
    headers: authHeaders(creds),
    params: {
      fields: INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: from, until: to }),
      /* One row for the whole window. Without this Meta segments by its own
         default and the caller would have to know to sum. */
      time_increment: "all_days",
      level: "campaign",
    },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  const numeric = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* No rows means the campaign delivered nothing in the window — a real answer,
     reached only because the read succeeded. A failed read threw. */
  if (!rows.length) {
    return {
      providerCampaignId: id, currency: null, rowsRead: 0,
      spend: null, impressions: null, reach: null, clicks: null, conversions: null,
      conversionActionTypes: [],
    };
  }

  const row = rows[0];

  /* ── `actions` IS NOT A CONVERSION COUNT ────────────────────────────────
     It is every tracked action of every type: link clicks, video views, page
     engagement, purchases. Summing it produces a number far larger than any
     conversion count and comparable to nothing.

     So GRAV totals only the outcome-shaped types, and publishes WHICH types it
     counted alongside the figure. A reader who disagrees with the definition can
     then see the definition instead of guessing at it. */
  const OUTCOME_ACTIONS = new Set([
    "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead",
    "purchase", "offsite_conversion.fb_pixel_purchase",
    "complete_registration", "offsite_conversion.fb_pixel_complete_registration",
    "submit_application", "schedule_total", "contact_total",
  ]);

  let conversions = null;
  const counted = [];
  if (Array.isArray(row?.actions)) {
    for (const action of row.actions) {
      const type = str(action?.action_type);
      if (!OUTCOME_ACTIONS.has(type)) continue;
      const value = numeric(action?.value);
      if (value === null) continue;
      conversions = (conversions === null ? 0 : conversions) + value;
      counted.push(type);
    }
  }

  return {
    providerCampaignId: id,
    currency: str(row?.account_currency) || null,
    rowsRead: rows.length,
    spend: numeric(row?.spend),
    impressions: numeric(row?.impressions),
    reach: numeric(row?.reach),
    clicks: numeric(row?.clicks),
    conversions,
    conversionActionTypes: counted,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   READS AGAINST AN EXPLICITLY NAMED ACCOUNT
   ───────────────────────────────────────────────────────────────────────────
   Everything above takes its account from the deployment secret. That is how
   the read chunk shipped and it stays.

   Nothing below does. Each takes the account from its caller, because these are
   the operations a DEPLOYMENT path uses, and a deployment's account comes from
   the company's binding — a decision somebody made — rather than from an
   environment variable nobody chose, and never from whichever account the
   credential happens to list first.
   ═══════════════════════════════════════════════════════════════════════════ */

/* `act_1234567890`, always, whichever form the caller holds. Meta's Graph API
   treats a bare number as ambiguous — it could name a page, a business or a
   pixel — so the prefix is part of the identifier rather than decoration. */
const actId = (value, field) => `act_${assertDigits(String(value ?? "").replace(/^act_/, ""), field)}`;

/* The fields a deployment needs before it can be safe. Every one is READ. */
const DEPLOY_ACCOUNT_FIELDS = [
  "id", "name", "currency", "timezone_name", "timezone_offset_hours_utc",
  "account_status", "disable_reason", "business", "capabilities",
  "is_prepay_account", "min_daily_budget",
].join(",");

/* ── META'S OWN ACCOUNT STATUS NUMBERS ──────────────────────────────────────
   The API answers with an integer. Named here so a refusal can say "the account
   is closed" rather than "account_status was 101", and so an unrecognised value
   stays unrecognised instead of being rounded to the nearest known one. */
const ACCOUNT_STATUS = Object.freeze({
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
});

/**
 * One account's own description, read from the account itself.
 *
 * Answers what a deployment has to know before it can be safe: the currency the
 * account bills in, the timezone its days and schedules are in, whether it is
 * active, and which business it sits in. Every one is read, never configured.
 */
async function describeAccount({ accountId, businessId = null }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const account = actId(accountId, "accountId");
  const operation = "account.describe";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/${account}`,
    headers: authHeaders(creds),
    params: { fields: DEPLOY_ACCOUNT_FIELDS },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the account" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });

  const answeredId = str(data.id);
  if (!answeredId) {
    /* A successful account read always names the account. No id means the read
       did not see it, and reporting a reachable account with unknown properties
       would let a deployment proceed against nothing. */
    throw fail("NOT_FOUND",
      "The advertising account did not answer with its own details.",
      { channel: CHANNEL });
  }

  const statusNumber = Number(data.account_status);
  const business = data.business && typeof data.business === "object" ? data.business : null;

  return {
    /* Returned in the form the caller gave, so an identity comparison upstream
       compares like with like. */
    accountId: answeredId,
    accountName: str(data.name) || null,
    currency: str(data.currency) || null,
    timeZone: str(data.timezone_name) || null,
    /* Meta's own word where GRAV recognises the number, and the number itself
       where it does not — an unrecognised status is not "active". */
    status: ACCOUNT_STATUS[statusNumber] || (Number.isInteger(statusNumber) ? `UNKNOWN_${statusNumber}` : ""),
    /* Only ever set when Meta says the account is disabled, and carried as its
       own field so "disabled" and "why" stay separate facts. */
    disableReason: data.disable_reason ? String(data.disable_reason) : "",
    /* ── THE BUSINESS, WHERE META EXPOSES IT ────────────────────────────
       Not every account has one, and a personal account legitimately does not.
       `null` therefore means "not exposed", which is different from "the wrong
       business" — a caller that treated them the same would refuse every
       personal account. */
    businessId: business ? str(business.id) || null : null,
    businessName: business ? str(business.name) || null : null,
    /* Echoed so a caller can see what it asked about beside what came back. */
    expectedBusinessId: businessId ? str(businessId) : null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities.map(str).filter(Boolean) : [],
    isPrepay: data.is_prepay_account === true,
  };
}

/**
 * Can GRAV read the objects a deployment would create?
 *
 * ── A CONNECTION THAT CAN WRITE BUT NOT READ PROVES NOTHING ────────────────
 * Everything GRAV creates has to be read back before it is called stopped. A
 * token with create permission and no read permission would let a campaign be
 * made and never confirmed, which is the state this whole design exists to
 * avoid. So the reads are checked BEFORE anything is created, not after.
 *
 * Each edge is asked separately, because Meta grants them separately.
 */
async function verifyDeploymentReads({ accountId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const account = actId(accountId, "accountId");

  const edges = [
    ["campaigns", "campaigns"],
    ["adsets", "adSets"],
    ["adcreatives", "creatives"],
    ["ads", "ads"],
  ];

  const out = {};
  for (const [edge, key] of edges) {
    const operation = `account.read.${edge}`;
    try {
      const { data } = await http.perform({
        channel: CHANNEL,
        operation,
        method: "GET",
        url: `${API_BASE}/${account}/${edge}`,
        headers: authHeaders(creds),
        params: { fields: "id", limit: 1 },
      });
      http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
      http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
      /* An empty list is a SUCCESSFUL read. A new account with no campaigns can
         still be read, and treating zero rows as a permission failure would
         block every first deployment. */
      http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });
      out[key] = true;
    } catch (err) {
      /* A refusal is a real answer about permission. Anything else means GRAV
         could not find out, and `null` says so rather than claiming `false`. */
      out[key] = str(err?.code) === "CHANNEL_ACCESS_REFUSED" ? false : null;
    }
  }
  return out;
}

/** Can GRAV read delivery figures for this account? */
async function verifyInsightsRead({ accountId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const account = actId(accountId, "accountId");
  const operation = "account.read.insights";

  try {
    const { data } = await http.perform({
      channel: CHANNEL,
      operation,
      method: "GET",
      url: `${API_BASE}/${account}/insights`,
      headers: authHeaders(creds),
      params: { fields: "impressions", date_preset: "yesterday", limit: 1 },
    });
    http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
    http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
    http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });
    return true;
  } catch (err) {
    return str(err?.code) === "CHANNEL_ACCESS_REFUSED" ? false : null;
  }
}

/**
 * Is the Pixel in the tracking configuration one this account can see?
 *
 * ── A PIXEL ID THAT PARSES IS NOT A PIXEL THE ACCOUNT HAS ──────────────────
 * The tracking configuration holds a public identifier a person typed. An
 * optimisation aimed at landing-page views needs a pixel Meta can actually read
 * for this account; one belonging to somebody else measures nothing, and the
 * campaign would optimise against silence.
 */
async function readPixel({ accountId, pixelId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const account = actId(accountId, "accountId");
  const wanted = assertDigits(String(pixelId ?? ""), "pixelId");
  const operation = "account.read.pixel";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/${account}/adspixels`,
    headers: authHeaders(creds),
    params: { fields: "id,name", limit: 100 },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  const found = rows.map((r) => ({ pixelId: str(r?.id), name: str(r?.name) || null }))
    .find((r) => r.pixelId === wanted);

  return { requested: wanted, found: found || null, accountPixelCount: rows.length };
}

/**
 * Locations matching one name, every match returned.
 *
 * ── EXACT NAME, AND GRAV CHOOSES NOTHING ───────────────────────────────────
 * Meta's search endpoint is a SUGGESTION service: it answers "Cambridge" with a
 * ranked list and is happy to answer a misspelling with something plausible.
 * Taking the first would target a place nobody chose, and nobody reviews a
 * location key.
 *
 * So the caller's name is compared exactly against what came back, every exact
 * match is returned, and deciding what several means is the resolver's job.
 */
async function searchGeoTargets({ name, types = [], limit = 25 }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "geoTarget.search";

  const wanted = str(name);
  if (!wanted) {
    throw fail("VALIDATION", "A location name is needed to look one up.", { field: "name" });
  }

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/search`,
    headers: authHeaders(creds),
    params: {
      type: "adgeolocation",
      q: wanted,
      /* Meta's own kinds, passed through from GRAV's table rather than built
         here, so one place decides what a GRAV "region" means. */
      ...(types.length ? { location_types: JSON.stringify(types) } : {}),
      limit,
    },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  return rows
    .map((r) => ({
      /* Meta's own key. A country is a two-letter code; everything else is an
         opaque string. Never constructed by GRAV. */
      key: str(r?.key),
      name: str(r?.name),
      type: str(r?.type),
      countryCode: str(r?.country_code) || null,
      countryName: str(r?.country_name) || null,
      region: str(r?.region) || null,
      /* The full label Meta shows, which is what a person needs to tell two
         places of the same name apart. */
      canonicalName: [str(r?.name), str(r?.region), str(r?.country_name)].filter(Boolean).join(", "),
      supportsRegion: r?.supports_region === true,
      supportsCity: r?.supports_city === true,
    }))
    .filter((r) => r.key);
}

/** Languages matching one code or name, every match returned. */
async function searchLocales({ query, limit = 25 }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "locale.search";

  const wanted = str(query);
  if (!wanted) {
    throw fail("VALIDATION", "A language is needed to look one up.", { field: "query" });
  }

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/search`,
    headers: authHeaders(creds),
    params: { type: "adlocale", q: wanted, limit },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  return rows
    .map((r) => ({ key: str(r?.key), name: str(r?.name) }))
    .filter((r) => r.key);
}

/**
 * The domains this business has verified, where the channel exposes them.
 *
 * Advisory rather than blocking: Meta requires domain verification for some
 * placements and objectives and not others, the rules change, and a preflight
 * that refused every unverified domain would block correct campaigns. So it is
 * reported, and a person decides.
 */
async function readVerifiedDomains({ businessId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const business = assertDigits(String(businessId ?? ""), "businessId");
  const operation = "business.read.domains";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/${business}/owned_domains`,
    headers: authHeaders(creds),
    params: { fields: "id,domain", limit: 100 },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  return rows.map((r) => str(r?.domain)).filter(Boolean);
}

/**
 * Everything in the bound account that belongs to one GRAV deployment.
 *
 * ── TWO SOURCES OF TRUTH, AND THE STRONGER ONE IS GRAV'S OWN RECORD ────────
 * `marker` is the ad label GRAV attaches. `knownObjectIds` are the identifiers
 * GRAV recorded during its own sequence — written after every confirmed step,
 * before the next one started.
 *
 * The known ids are used FIRST and are the stronger evidence: the channel named
 * those objects to GRAV directly, whereas the label's read-back behaviour has
 * not been confirmed against a real account. The marker is looked up as well,
 * because after a lost response GRAV may have created something it never got an
 * id for — and that is the one case only the marker can answer.
 *
 * Returns FACTS and forms no opinion; deciding whether what came back is a
 * complete hierarchy is the reconciler's job.
 */
async function readDeploymentByMarker({ accountId, marker, knownObjectIds = [] }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const account = actId(accountId, "accountId");

  const wanted = str(marker);
  if (!wanted) {
    throw fail("VALIDATION", "A deployment marker is needed to look one up.", { field: "marker" });
  }

  const ask = async (operation, path, params) => {
    const { data } = await http.perform({
      channel: CHANNEL, operation, method: "GET",
      url: `${API_BASE}/${path}`, headers: authHeaders(creds), params,
    });
    http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
    http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
    return data;
  };

  const objects = [];
  let uploadedImageHash = "";

  /* ── THE OBJECTS GRAV NAMED, READ BACK ONE BY ONE ───────────────────────
     Each by its own id, because a list read would have to be filtered and a
     filter is where a wrong object slips in. */
  const FIELDS = Object.freeze({
    campaign: "id,name,status,objective,special_ad_categories",
    audience_group: "id,name,status,campaign_id,optimization_goal,billing_event,daily_budget,lifetime_budget,start_time,end_time,targeting",
    creative: "id,name,object_story_spec",
    advertisement: "id,name,status,adset_id,creative",
  });

  for (const known of knownObjectIds) {
    const role = str(known?.role);
    const id = str(known?.providerObjectId);
    if (!FIELDS[role] || !id) {
      /* The uploaded image is recorded with the channel's own hash rather than
         an object id, so it is carried through rather than looked up. */
      if (role === "creative_image" && id) uploadedImageHash = id;
      continue;
    }

    let row;
    try {
      row = await ask(`marker.read.${role}`, id, { fields: FIELDS[role] });
    } catch (err) {
      /* An object GRAV recorded and can no longer read is a real finding, not a
         failure: somebody may have deleted it. Recorded as absent rather than
         collapsing the whole read. */
      if (str(err?.code) === "CHANNEL_ACCESS_REFUSED" || str(err?.code) === "NOT_FOUND") continue;
      throw err;
    }

    const t = row.targeting && typeof row.targeting === "object" ? row.targeting : null;
    objects.push({
      role,
      providerObjectId: str(row.id) || id,
      name: str(row.name),
      status: str(row.status),
      parentId: str(row.campaign_id) || str(row.adset_id) || "",
      creativeId: str(row.creative?.id),
      /* Meta nests the image hash inside the creative's story spec. */
      imageHash: str(row.object_story_spec?.link_data?.image_hash),
      targeting: t ? {
        includedLocationKeys: flattenGeo(t.geo_locations),
        excludedLocationKeys: flattenGeo(t.excluded_geo_locations),
        localeKeys: Array.isArray(t.locales) ? t.locales.map(str) : [],
        ageMin: t.age_min,
        ageMax: t.age_max,
        genders: Array.isArray(t.genders) ? t.genders.map(Number) : [],
        /* Proto-ish again: an absent automation block is the channel's default,
           which is expansion ON. Read strictly, and absent counts as on — the
           safe direction for a field that widens an approved audience. */
        audienceExpansion: t.targeting_automation
          ? Object.values(t.targeting_automation).some((v) => v === 1 || v === true)
          : true,
      } : null,
    });
  }

  /* ── AND THE MARKER, FOR WHAT GRAV NEVER GOT AN ID FOR ──────────────────
     After a lost response there may be a campaign GRAV created and cannot name.
     This is the only thing that can find it. */
  let markerCampaigns = [];
  try {
    const labels = await ask("marker.findLabel", `${account}/adlabels`, { fields: "id,name", limit: 200 });
    const rows = http.requireArray(labels, "data", { channel: CHANNEL, operation: "marker.findLabel", absentMeansEmpty: false });
    const label = rows.map((r) => ({ id: str(r?.id), name: str(r?.name) })).find((r) => r.name === wanted);

    if (label?.id) {
      const tagged = await ask("marker.findCampaigns", `${account}/campaigns`, {
        fields: "id,name,status",
        filtering: JSON.stringify([{ field: "campaign.adlabels", operator: "ANY", value: [label.id] }]),
        limit: 50,
      });
      const campaignRows = http.requireArray(tagged, "data",
        { channel: CHANNEL, operation: "marker.findCampaigns", absentMeansEmpty: false });
      markerCampaigns = campaignRows
        .map((r) => ({ providerObjectId: str(r?.id), name: str(r?.name), status: str(r?.status) }))
        .filter((c) => c.providerObjectId);
    }
  } catch {
    /* The label read is best-effort while its behaviour is unverified. A failure
       here does not discard the objects GRAV read back by id above. */
    markerCampaigns = [];
  }

  /* Campaigns GRAV can point at: the one it recorded, plus any the marker found
     that it did not already have. More than one is a real situation the
     reconciler refuses to resolve on its own. */
  const recorded = objects.filter((o) => o.role === "campaign");
  const extra = markerCampaigns.filter((c) => !recorded.some((r) => r.providerObjectId === c.providerObjectId));

  return {
    marker: wanted,
    objects,
    campaigns: [...recorded, ...extra],
    uploadedImageHash,
  };
}

/* Meta's `geo_locations` is an object of typed lists. Flattened to the keys
   themselves so a comparison does not have to know the shape. */
function flattenGeo(geo) {
  if (!geo || typeof geo !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(geo)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      out.push(typeof entry === "string" ? entry : str(entry?.key));
    }
    void key;
  }
  return out.filter(Boolean);
}

/* ── THE DAILY INSIGHT FIELD SET ────────────────────────────────────────────
   `actions` and `action_values` are needed for conversions and their value;
   everything else is a plain metric. Deliberately no breakdowns: Meta will
   segment by age, gender, placement and region on request, and none of that
   belongs in a body somebody later renders. */
const DAILY_INSIGHT_FIELDS = [
  "date_start", "date_stop", "spend", "impressions", "reach", "clicks",
  "actions", "action_values", "account_currency",
].join(",");

/* ── WHAT META COUNTS AS AN OUTCOME ─────────────────────────────────────────
   `actions` is every tracked action of every type — link clicks, video views,
   page engagement, purchases. Summing it produces a number far larger than any
   conversion count and comparable to nothing.

   So GRAV totals only the outcome-shaped types and publishes WHICH ones it
   counted beside the figure. Shared with the aggregate reader above so the two
   cannot drift into counting different things. */
const OUTCOME_ACTION_TYPES = Object.freeze([
  "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead",
  "purchase", "offsite_conversion.fb_pixel_purchase",
  "complete_registration", "offsite_conversion.fb_pixel_complete_registration",
  "submit_application", "schedule_total", "contact_total",
]);

/* Meta reports a loaded landing page as its own action type. It exists only
   where a pixel is configured, so its absence is absence — not zero. */
const LANDING_PAGE_VIEW_TYPES = Object.freeze(["landing_page_view", "omni_landing_page_view"]);

/**
 * One campaign's insights, one row per day, against an explicitly named account.
 *
 * ── SEGMENTED BY DAY, AND SCOPED TO ONE CAMPAIGN ───────────────────────────
 * `time_increment: 1` is what makes Meta return a row per day rather than one
 * row for the window. The read is made against the campaign node itself, so it
 * cannot return another campaign's figures even if the account holds hundreds.
 *
 * @returns {Promise<{currency:string|null, days:object[]}>}
 */
async function campaignDailyInsights({ campaignId, startDate, endDate }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const operation = "campaign.dailyInsights";

  const id = assertDigits(campaignId, "campaignId");
  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${API_BASE}/${id}/insights`,
    headers: authHeaders(creds),
    params: {
      fields: DAILY_INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: from, until: to }),
      time_increment: 1,
      level: "campaign",
      limit: 500,
    },
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  const rows = http.requireArray(data, "data", { channel: CHANNEL, operation, absentMeansEmpty: false });

  const numeric = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* Sum the entries of an action list whose type is in `wanted`. Returns null
     when the list is absent entirely — which is what "the channel did not tell
     us" looks like — and a number once at least one entry matched. */
  const sumActions = (list, wanted) => {
    if (!Array.isArray(list)) return { total: null, counted: [] };
    let total = null;
    const counted = [];
    for (const entry of list) {
      const type = str(entry?.action_type);
      if (!wanted.includes(type)) continue;
      const value = numeric(entry?.value);
      if (value === null) continue;
      total = (total === null ? 0 : total) + value;
      counted.push(type);
    }
    return { total, counted };
  };

  let currency = null;
  const days = [];

  for (const row of rows) {
    const date = str(row?.date_start);
    if (!date) continue;
    currency = currency || str(row?.account_currency) || null;

    const conversions = sumActions(row?.actions, OUTCOME_ACTION_TYPES);
    const value = sumActions(row?.action_values, OUTCOME_ACTION_TYPES);
    const pageViews = sumActions(row?.actions, LANDING_PAGE_VIEW_TYPES);

    days.push({
      date,
      impressions: numeric(row?.impressions),
      /* Meta reports reach; Google does not. */
      reach: numeric(row?.reach),
      clicks: numeric(row?.clicks),
      landingPageViews: pageViews.total,
      /* A decimal string in MAJOR units — "12.34" — which is exact to two
         places, unlike Google's micros. Carried as given so the caller does the
         one conversion. */
      spend: numeric(row?.spend),
      conversions: conversions.total,
      conversionValue: value.total,
      conversionActionTypes: [...new Set(conversions.counted)],
    });
  }

  return { currency, days, rowsRead: rows.length };
}

module.exports = {
  CHANNEL,
  API_VERSION,
  accessibleAccounts,
  verifyAccount,
  verifyReporting,
  listCampaigns,
  campaignInsights,
  campaignDailyInsights,
  OUTCOME_ACTION_TYPES,

  /* Explicit-account reads, used by the Meta deployment path. */
  describeAccount,
  verifyDeploymentReads,
  verifyInsightsRead,
  readPixel,
  searchGeoTargets,
  searchLocales,
  readVerifiedDomains,
  readDeploymentByMarker,
  ACCOUNT_STATUS,
  __test: { assertDigits, assertDate, STATUS_FILTER },
};
