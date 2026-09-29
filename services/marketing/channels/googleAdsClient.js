// services/marketing/channels/googleAdsClient.js
//
// GOOGLE ADS, AS A CLOSED SET OF FOUR READS.
//
// ── THE OPERATION TABLE IS THE SECURITY BOUNDARY ───────────────────────────
// Four exported operations, no more, and not one of them takes a URL, a path, a
// method or a query fragment from a caller:
//
//   accessibleAccounts()            which accounts this identity can see
//   verifyAccount()                 can GRAV read the configured account
//   listCampaigns({ … })            one page of campaigns
//   campaignReport({ … })           one campaign's metrics for a date range
//
// Google Ads is queried in GAQL, which is a query language — so the obvious
// shape for an adapter is `query(gaql)`, and that would be the whole API surface
// handed to whoever calls it next. Every query in this file is a CONSTANT with
// typed parameters substituted by the functions below, and every parameter is
// validated against a pattern before it reaches a query string. A campaign id is
// digits or it is refused; a date is `YYYY-MM-DD` or it is refused; a status is a
// key in a closed map or it is refused.
//
// ── WHY `search` RATHER THAN `searchStream` ────────────────────────────────
// `search` pages; `searchStream` streams a potentially unbounded response into
// memory. A list screen needs a page. The API version is not named here: it is
// the one `constants/marketingGoogleAdsApi.js` selects (v25), and every URL in
// this file is built from it.
//
// ── WHAT GOOGLE ADS DOES NOT REPORT ────────────────────────────────────────
// There is no reach and no session count in the Ads API. Those are marked
// `unsupported` rather than zero by the normalisation layer, because a zero
// would say Google measured none and Google measured nothing at all.
"use strict";

const { fail } = require("../../storePurchase/errors");
const http = require("./channelHttp");
const secrets = require("./channelSecrets");

const CHANNEL = "google_ads";
/* ── THE VERSION IS NOT CHOSEN HERE ─────────────────────────────────────────
   Every Google Ads URL is built from `constants/marketingGoogleAdsApi.js`, so
   the read client and the write bundle cannot drift onto different versions,
   and a sunset version is refused rather than called. */
const googleApi = require("../../../constants/marketingGoogleAdsApi");
const googleErrors = require("./googleAdsErrors");

const API_VERSION = googleApi.SELECTED_VERSION;
const TOKEN_URL = googleApi.TOKEN_URL;

const str = (v) => String(v ?? "").trim();

/* ── EVERY VALUE THAT REACHES A QUERY IS PATTERN-CHECKED ────────────────────
   GAQL has no parameter binding, so the only defence against a value changing
   the meaning of a query is to refuse a value that could. These are not
   sanitisers — nothing is escaped or stripped — they are gates. */
const { assertCalendarDate } = require("./channelDates");

const assertDigits = (value, field) => {
  const v = str(value);
  if (!/^\d{1,20}$/.test(v)) {
    throw fail("VALIDATION", `${field} must be a whole number.`, { field });
  }
  return v;
};

/* The shared strict validator, not a shape check. A pattern alone accepts
   `2026-02-31`, which Google may normalise into March — producing a report
   labelled February that contains a different month's data. */
const assertDate = (value, field) => assertCalendarDate(value, field);

/* The only campaign statuses GRAV will filter on, and the only GAQL text that
   can result. A caller supplies a GRAV status code; nothing a caller writes
   becomes query text. */
const STATUS_FILTER = Object.freeze({
  active: "campaign.status = 'ENABLED'",
  paused: "campaign.status = 'PAUSED'",
  removed: "campaign.status = 'REMOVED'",
});

/* ── THE FIELD LISTS, AS CONSTANTS ──────────────────────────────────────────
   Deliberately narrow. Google Ads will return whatever is asked for, including
   fields carrying search terms, geographic detail and audience segments — none
   of which this chunk needs and all of which would then be in a response body
   somebody later renders. */
const CAMPAIGN_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  /* v25 has no `start_date`/`end_date`: they became `*_date_time`,
     "yyyy-MM-dd HH:mm:ss" in the account's timezone. */
  "campaign.start_date_time",
  "campaign.end_date_time",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "customer.currency_code",
].join(", ");

const METRIC_FIELDS = [
  "campaign.id",
  "campaign.name",
  "metrics.cost_micros",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.conversions",
  "customer.currency_code",
].join(", ");

/* ── THE ACCESS TOKEN, AND WHY IT IS NOT CACHED ACROSS COMPANIES ────────────
   One deployment, one set of credentials, so a process-level cache is correct
   here and would NOT be once a second company's credentials exist. Keyed on the
   refresh token's fingerprint rather than left global, so the day that changes
   the cache cannot serve company A's token to company B.

   The fingerprint is a hash. The refresh token itself is never a cache key, a
   log line or a property name. */
const crypto = require("crypto");
const tokenCache = new Map();

const fingerprint = (value) =>
  crypto.createHash("sha256").update(str(value)).digest("hex").slice(0, 16);

async function accessToken(creds) {
  const key = fingerprint(creds.refreshToken);
  const cached = tokenCache.get(key);
  /* Sixty seconds of headroom, so a token that expires mid-request is renewed
     before the request rather than halfway through it. */
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const { data } = await http.perform({
    channel: CHANNEL,
    operation: "oauth.refresh",
    method: "POST",
    /* A token exchange. It creates nothing in the advertising account, and it is
       the one POST in this file that is not a report read. */
    readIntent: true,
    url: TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    /* Not retried. A refused refresh token is refused on the second attempt
       too, and Google rate-limits this endpoint per client. */
    retries: 0,
    classify: (status, body) => googleErrors.classifyTokenFailure(status, body),
  });

  const token = str(data?.access_token);
  if (!token) {
    /* The body is NOT logged: a token response contains a token. */
    console.error(`[marketing-channel] ${CHANNEL} oauth.refresh returned no access token`);
    throw fail("CHANNEL_OAUTH_UNAVAILABLE", googleErrors.MESSAGES.CHANNEL_OAUTH_UNAVAILABLE,
      { channel: CHANNEL, operation: "oauth.refresh" });
  }

  const ttlMs = (Number(data?.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

function headersFor(creds, token) {
  /* ── NO DEVELOPER TOKEN ──────────────────────────────────────────────────
     Sunset by Google on 2026-09-09: "optional and ignored", and to be rejected
     in a future major version. Access comes from the Cloud project that owns
     the OAuth client, so the bearer token is the credential. */
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  /* Only when the advertising account sits under a manager account. Sending an
     empty one is a 400 from Google, which would surface as a malformed response
     and send an operator looking for an API change. */
  if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId;
  return headers;
}

/**
 * Run one constant GAQL query. Private: nothing outside this file may name a
 * query.
 *
 * ── NO PAGE SIZE ───────────────────────────────────────────────────────────
 * Google fixes a search page at 10,000 rows and answers a request carrying
 * `pageSize` with PAGE_SIZE_NOT_SUPPORTED. A bounded read says so in the query
 * (`LIMIT n`), which Google documents, and never in the body.
 */
async function search({ env = process.env, creds, token, customerId, query, pageToken, operation }) {
  const body = { query };
  if (pageToken) body.pageToken = pageToken;

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "POST",
    /* Google's reporting endpoint is a POST that reads. Named here so the
       allowance is attached to this one endpoint. */
    readIntent: true,
    url: `${googleErrors.versionedBase(env)}/customers/${customerId}/googleAds:search`,
    headers: headersFor(creds, token),
    data: body,
    classify: googleErrors.classify,
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  return {
    /* ── ABSENT `results` IS GENUINELY EMPTY, FOR THIS ENDPOINT ────────────
       Google Ads' REST surface is proto3 JSON, which omits an empty repeated
       field rather than sending `[]`. A page that matched nothing therefore
       arrives with no `results` key at all, and treating that as malformed would
       make "this account has no campaigns" an error. A `results` of the wrong
       TYPE is still malformed, which is the case that matters. */
    rows: http.requireArray(data, "results", { channel: CHANNEL, operation, absentMeansEmpty: true }),
    nextPageToken: str(data.nextPageToken) || null,
    /* Google sends this only when asked; absent is not zero, it is unknown. */
    totalResults: Number.isInteger(Number(data.totalResultsCount))
      ? Number(data.totalResultsCount)
      : null,
  };
}

/**
 * The advertising accounts this identity can see.
 *
 * Used only to answer "which accounts could this be configured against", for an
 * administrator choosing one. Ordinary callers never receive it.
 */
async function accessibleAccounts(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const operation = "accounts.list";

  const { data } = await http.perform({
    channel: CHANNEL,
    operation,
    method: "GET",
    url: `${googleErrors.versionedBase(env)}/customers:listAccessibleCustomers`,
    classify: googleErrors.classify,
    headers: headersFor(creds, token),
  });

  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
  /* Same proto3 rule: an identity with access to no accounts gets no
     `resourceNames` key rather than an empty array. */
  const names = http.requireArray(data, "resourceNames", { channel: CHANNEL, operation, absentMeansEmpty: true });
  return names.map((n) => str(n).replace(/^customers\//, "")).filter(Boolean);
}

/**
 * Can GRAV read the configured account?
 *
 * A real read of one row, not a ping. An endpoint that answers without touching
 * the account would report healthy for an account the credential cannot see.
 */
async function verifyAccount(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  const { rows } = await search({ env,
    creds, token, customerId: creds.customerId,
    operation: "account.verify",
    query: "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
  });

  const customer = rows[0]?.customer || null;
  return {
    /* Returned so an administrator can confirm GRAV is pointed at the account
       they meant. It is the account the operator configured, not a discovery of
       somebody else's. */
    accountId: str(customer?.id) || creds.customerId,
    accountName: str(customer?.descriptiveName) || null,
    currency: str(customer?.currencyCode) || null,
    timeZone: str(customer?.timeZone) || null,
  };
}

/* ── GRAV'S OWN PAGE TOKEN FOR THE CAMPAIGN LIST ────────────────────────────
   Google no longer accepts a page size, and its own pages are 10,000 rows. A
   page of 25 is therefore GRAV's: ordered by `campaign.id` (unique, filterable
   and sortable in v25), bounded by LIMIT, and continued with
   `campaign.id > last`. That is an exact keyset — no row repeats or is skipped
   when campaigns are added between pages — and the token carries only digits,
   so nothing a caller returns can become query text. The inventory service
   signs it before it reaches a browser. */
const CAMPAIGN_TOKEN = /^gc1:(\d{1,20})$/;
const MAX_CAMPAIGN_PAGE = 200;

/**
 * One page of campaigns.
 *
 * @param {object} args
 * @param {string} [args.status]    a GRAV campaign status to filter on
 * @param {string} [args.pageToken] a token this function returned earlier
 * @param {number} [args.pageSize]
 */
async function listCampaigns({ status = null, pageToken = null, pageSize = 25 } = {}, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  const clauses = [];
  if (status) {
    const clause = STATUS_FILTER[str(status)];
    if (!clause) {
      throw fail("VALIDATION", "That is not a campaign status Google Ads can be filtered by.", {
        field: "status", accepted: Object.keys(STATUS_FILTER),
      });
    }
    clauses.push(clause);
  } else {
    /* Without this, Google returns removed campaigns alongside live ones and a
       marketer's list fills with years of deleted work. A caller can still ask
       for them explicitly by status. */
    clauses.push("campaign.status != 'REMOVED'");
  }

  if (pageToken) {
    const m = CAMPAIGN_TOKEN.exec(str(pageToken));
    if (!m) throw fail("VALIDATION", "pageToken is malformed.", { field: "pageToken" });
    clauses.push(`campaign.id > ${m[1]}`);
  }

  const size = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, MAX_CAMPAIGN_PAGE) : 25;
  /* One more than asked for: its presence is how "there is a next page" is
     known without a second request. */
  const query = `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE ${clauses.join(" AND ")} `
    + `ORDER BY campaign.id ASC LIMIT ${size + 1}`;

  const page = await search({ env,
    creds, token, customerId: creds.customerId, query,
    operation: "campaigns.list",
  });

  const more = page.rows.length > size;
  const rows = page.rows.slice(0, size);
  const lastId = str(rows[rows.length - 1]?.campaign?.id);

  /* The calendar day of a v25 date-time, so the provider-neutral row keeps its
     date-only shape. */
  const day = (v) => (str(v) ? str(v).slice(0, 10) : null);

  return {
    rows: rows.map((r) => ({
      providerCampaignId: str(r?.campaign?.id),
      name: str(r?.campaign?.name) || null,
      providerStatus: str(r?.campaign?.status) || null,
      objective: str(r?.campaign?.advertisingChannelType) || null,
      startDate: day(r?.campaign?.startDateTime),
      endDate: day(r?.campaign?.endDateTime),
      /* Google reports money in micros. Converted once, here, and never rounded
         to a display precision — the normalisation layer keeps the provider's
         own precision and its currency. */
      dailyBudgetMicros: r?.campaignBudget?.amountMicros ?? null,
      lifetimeBudgetMicros: r?.campaignBudget?.totalAmountMicros ?? null,
      currency: str(r?.customer?.currencyCode) || null,
      /* Google Ads exposes no campaign-level modified time in this selection.
         Null rather than "now", which would claim a freshness GRAV did not
         observe. */
      providerUpdatedAt: null,
    })),
    nextPageToken: more && /^\d+$/.test(lastId) ? `gc1:${lastId}` : null,
    totalResults: null,
  };
}

/**
 * Can GRAV read REPORTING, as opposed to campaign configuration?
 *
 * ── WHY THIS IS NOT INFERRED FROM THE CAMPAIGN LIST ────────────────────────
 * The first version marked reporting confirmed whenever the campaign list
 * succeeded, on the reasoning that both share a credential and an endpoint
 * family. They do, and it still proved nothing.
 *
 * A campaign list selects `campaign.*` fields, which are configuration. A report
 * selects `metrics.*`, which Google gates differently: a developer token with
 * test-account access serves configuration and refuses metrics, and an account
 * whose reporting is restricted answers the first query and refuses the second.
 * Inferring one from the other reports a half-working connection as healthy, and
 * the first symptom a marketer sees is a permanently empty performance screen
 * with nothing anywhere explaining it.
 *
 * So this is a real report: one metric, one day, one row. Deliberately the
 * smallest query that still touches the reporting surface.
 */
async function verifyReporting(env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  /* Yesterday, which exists in every account timezone by the time any server
     asks. Today can be a date the account has not reached yet. */
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  await search({ env,
    creds, token, customerId: creds.customerId,
    operation: "reporting.verify",
    query: `SELECT campaign.id, metrics.impressions FROM campaign WHERE segments.date BETWEEN '${day}' AND '${day}' LIMIT 1`,
  });

  /* Zero rows is a successful reporting read. An account that spent nothing
     yesterday is not an account GRAV cannot report on, and treating an empty
     result as a failure would mark every quiet account as broken. */
  return true;
}

/**
 * One campaign's metrics over an explicit date range.
 *
 * ── A SEGMENTED REPORT RETURNS MANY ROWS, AND THEY ARE SUMMED HERE ─────────
 * Without `segments.date` in the selection Google aggregates over the window
 * and returns one row, which is what this asks for. The loop below still handles
 * several, because a future field addition that introduces a segment would
 * otherwise silently report only the first day.
 *
 * An absent metric stays absent. Google omits a metric key it has no data for,
 * and `?? null` preserves that — `Number(undefined)` would be `NaN` and
 * `Number(null)` would be `0`, which is the bug this whole contract exists to
 * avoid.
 */
async function campaignReport({ providerCampaignId, startDate, endDate }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  const id = assertDigits(providerCampaignId, "campaignId");
  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");

  const query = `SELECT ${METRIC_FIELDS} FROM campaign `
    + `WHERE campaign.id = ${id} AND segments.date BETWEEN '${from}' AND '${to}'`;

  const page = await search({ env,
    creds, token, customerId: creds.customerId, query,
    operation: "campaign.report",
  });

  /* No rows is a real answer: the campaign existed and delivered nothing in the
     window. Distinguished from a failed read by the fact that this returned at
     all — a failure throws. */
  if (!page.rows.length) {
    return {
      providerCampaignId: id, currency: null, rowsRead: 0,
      costMicros: null, impressions: null, clicks: null, conversions: null,
    };
  }

  let costMicros = null;
  let impressions = null;
  let clicks = null;
  let conversions = null;
  let currency = null;

  const add = (acc, value) => {
    if (value === undefined || value === null || value === "") return acc;
    const n = Number(value);
    if (!Number.isFinite(n)) return acc;
    return (acc === null ? 0 : acc) + n;
  };

  for (const row of page.rows) {
    const m = row?.metrics || {};
    costMicros = add(costMicros, m.costMicros);
    impressions = add(impressions, m.impressions);
    clicks = add(clicks, m.clicks);
    conversions = add(conversions, m.conversions);
    currency = currency || str(row?.customer?.currencyCode) || null;
  }

  return {
    providerCampaignId: id, currency, rowsRead: page.rows.length,
    costMicros, impressions, clicks, conversions,
  };
}

/* ── GAQL STRING LITERALS ───────────────────────────────────────────────────
   Single-quoted with backslash escapes. A value carrying a quote would otherwise
   end the literal and the rest would be parsed as query syntax. Every
   caller-supplied string that reaches a query goes through this; nothing else
   from a caller ever does. */
const gaql = (value) => str(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* ═══════════════════════════════════════════════════════════════════════════
   READS AGAINST AN EXPLICITLY NAMED ACCOUNT
   ───────────────────────────────────────────────────────────────────────────
   Everything above takes its account from `creds.customerId`, the deployment
   secret. That is how the read chunk shipped and it stays.

   Nothing below does. Each takes `customerId` from its caller, because these
   are the operations a WRITE path uses, and a write path's account comes from
   the company's binding — a decision somebody made — rather than from an
   environment variable nobody chose. There is no default parameter on any of
   them: omitting the account is an error, not a fallback.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One account's own description, read from the account itself.
 *
 * Answers the questions a create has to know before it can be safe: which
 * currency this account bills in, which timezone its days are, whether it is a
 * manager account that cannot hold campaigns at all, and whether it is still
 * open. Every one of them is read, not configured.
 */
async function describeAccount({ customerId, loginCustomerId = null }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const operation = "account.describe";

  const { rows } = await search({ env,
    /* The manager account comes from the binding too. A create under a manager
       needs the header, and taking it from the environment would send requests
       through a manager nobody bound. */
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation,
    query: "SELECT customer.id, customer.descriptive_name, customer.currency_code, "
      + "customer.time_zone, customer.manager, customer.status, customer.test_account "
      + "FROM customer LIMIT 1",
  });

  const customer = rows[0]?.customer || null;
  if (!customer) {
    /* A `customer` query against an account GRAV can reach always returns the
       account. No rows means the read did not see it, and reporting it as a
       reachable account with unknown properties would let a create proceed. */
    throw fail("NOT_FOUND",
      "The advertising account did not answer with its own details.",
      { channel: CHANNEL });
  }

  return {
    accountId: str(customer.id) || account,
    accountName: str(customer.descriptiveName) || null,
    currency: str(customer.currencyCode) || null,
    timeZone: str(customer.timeZone) || null,
    /* Google sends proto3 booleans, so an absent key means false. These two are
       read as strict booleans rather than truthiness, because `isManager`
       being wrong in the false direction lets a create run against an account
       that will refuse every object. */
    isManager: customer.manager === true,
    isTestAccount: customer.testAccount === true,
    status: str(customer.status) || null,
  };
}

/**
 * Campaigns in the named account whose name is exactly `name`.
 *
 * ── WHY THIS EXISTS, AND WHAT IT IS NOT ────────────────────────────────────
 * A campaign name is the only marker GRAV can attach to a Google campaign and
 * read back without a second store — Google Ads has no user-settable external
 * id on a campaign. So a name lookup is what a reconciliation would use after a
 * lost response.
 *
 * It is used here only to REFUSE: preflight asks whether the name is already
 * taken, and a match blocks creation. It is deliberately not used to decide
 * that a lost create succeeded. Names are not unique in Google Ads, a removed
 * campaign keeps its name, and this behaviour has not been verified against a
 * real account in this deployment — see the note in
 * `docs/decisions/marketing-google-search-deployment.md`. Treating an
 * unverified marker as proof is how a duplicate campaign gets created, or a
 * real one gets abandoned.
 */
async function findCampaignsByName({ customerId, loginCustomerId = null, name }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const operation = "campaign.findByName";

  const wanted = str(name);
  if (!wanted) {
    throw fail("VALIDATION", "A campaign name is needed to look one up.", { field: "name" });
  }
  /* ── THE ONLY VALUE A CALLER PUTS INTO A QUERY ──────────────────────────
     GAQL string literals are single-quoted with backslash escapes. A name
     carrying a quote would otherwise end the literal and the rest would be
     parsed as query syntax. Escaped here rather than trusted because a campaign
     name is author-supplied text. */
  const literal = gaql(wanted);

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation,
    query: "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type "
      + `FROM campaign WHERE campaign.name = '${literal}' LIMIT 50`,
  });

  return page.rows
    .map((row) => ({
      providerCampaignId: str(row?.campaign?.id),
      name: str(row?.campaign?.name),
      status: str(row?.campaign?.status),
      channelType: str(row?.campaign?.advertisingChannelType),
    }))
    .filter((c) => c.providerCampaignId);
}

/**
 * Whether the named account has a conversion action Google can bid towards.
 *
 * Only a bidding strategy aiming at a cost per conversion needs one. Asked as a
 * read so the refusal can be GRAV's sentence rather than Google's opaque field
 * error arriving halfway through a creation.
 */
async function hasConversionAction({ customerId, loginCustomerId = null }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation: "conversionAction.verify",
    query: "SELECT conversion_action.id, conversion_action.status FROM conversion_action "
      + "WHERE conversion_action.status = 'ENABLED' LIMIT 1",
  });

  return page.rows.length > 0;
}

/**
 * Read back the delivery status of objects GRAV just created.
 *
 * ── THE READ THAT MAKES "PAUSED" A FACT ────────────────────────────────────
 * A create that returned 200 is not a paused campaign. This is the separate
 * read whose result becomes `nonDeliveringConfirmed` on the attempt record, and
 * nothing else may set that field.
 *
 * ── GOOGLE'S RESOURCES, NEVER GRAV'S ROLE NAMES ────────────────────────────
 * An earlier version queried `FROM audience_group`, `FROM advertisement` and
 * `FROM targeting_term` — GRAV's provider-neutral roles, which are not Google
 * resources — so Google would have refused three of the four reads. The
 * translation lives in one table (`ROLE_TO_RESOURCE`); the role names only
 * ever appear in what this returns.
 *
 * ── THE BUDGET IS REPORTED, NOT GIVEN A DELIVERY STATUS ────────────────────
 * `campaign_budget.status` is ENABLED or REMOVED: whether the budget object
 * exists, not whether anything is being shown. Reporting it as "paused" or
 * "enabled" delivery would be inventing an answer. It is returned separately
 * as `budgets`, with `deliveryStateApplies: false`, and never enters `states`.
 */
async function readDeliveryStates({ customerId, loginCustomerId = null, campaignId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const id = assertDigits(campaignId, "campaignId");
  const R = googleApi.ROLE_TO_RESOURCE;

  const withLogin = loginCustomerId
    ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") }
    : creds;
  const ask = (operation, query) => search({ env, creds: withLogin, token, customerId: account, operation, query });

  /* The campaign and its budget in one row: `campaign_budget` is an attributed
     resource of `campaign`, while the budget resource itself cannot be joined
     back to a campaign. */
  const campaignPage = await ask("campaign.readState",
    `SELECT ${R.campaign}.id, ${R.campaign}.status, ${R.budget}.id, ${R.budget}.status, `
    + `${R.budget}.amount_micros, ${R.budget}.total_amount_micros, ${R.budget}.period `
    + `FROM ${R.campaign} WHERE campaign.id = ${id} LIMIT 1`);

  const adGroupPage = await ask("adGroup.readState",
    `SELECT ${R.audience_group}.id, ${R.audience_group}.status FROM ${R.audience_group} `
    + `WHERE campaign.id = ${id}`);

  const adPage = await ask("adGroupAd.readState",
    `SELECT ${R.advertisement}.ad.id, ${R.advertisement}.status FROM ${R.advertisement} `
    + `WHERE campaign.id = ${id}`);

  const criterionPage = await ask("adGroupCriterion.readState",
    `SELECT ${R.targeting_term}.criterion_id, ${R.targeting_term}.status FROM ${R.targeting_term} `
    + `WHERE campaign.id = ${id} AND ${R.targeting_term}.type = 'KEYWORD'`);

  const states = [];
  const budgets = [];
  for (const row of campaignPage.rows) {
    states.push({ role: "campaign", providerObjectId: str(row?.campaign?.id), status: str(row?.campaign?.status) });
    const b = row?.campaignBudget;
    if (b && str(b.id)) {
      budgets.push({
        role: "budget",
        providerObjectId: str(b.id),
        exists: str(b.status) !== "REMOVED",
        /* int64 kept as text: proto3 JSON sends it as a string, and a number
           would lose digits above 2^53. */
        amountMicros: b.amountMicros === undefined ? null : str(b.amountMicros),
        totalAmountMicros: b.totalAmountMicros === undefined ? null : str(b.totalAmountMicros),
        period: str(b.period) || null,
        deliveryStateApplies: false,
      });
    }
  }
  for (const row of adGroupPage.rows) {
    states.push({ role: "audience_group", providerObjectId: str(row?.adGroup?.id), status: str(row?.adGroup?.status) });
  }
  for (const row of adPage.rows) {
    states.push({ role: "advertisement", providerObjectId: str(row?.adGroupAd?.ad?.id), status: str(row?.adGroupAd?.status) });
  }
  for (const row of criterionPage.rows) {
    states.push({ role: "targeting_term", providerObjectId: str(row?.adGroupCriterion?.criterionId), status: str(row?.adGroupCriterion?.status) });
  }

  const out = states.filter((st) => st.providerObjectId);
  /* Attached rather than mixed in, so the existing callers that walk the
     array as delivery states keep seeing only objects that have one. */
  Object.defineProperty(out, "budgets", { value: budgets, enumerable: false });
  return out;
}

/**
 * Look up the stable criterion identifiers for one location name.
 *
 * ── EXACT NAME, AGAINST THE BOUND ACCOUNT, AND EVERY MATCH RETURNED ────────
 * `geo_target_constant` is queried through the bound account's own search
 * endpoint, so the identifiers come from the account GRAV will create in rather
 * than from a service call nobody chose an account for.
 *
 * The match is EXACT on the name. Not a prefix, not a suggestion service, not a
 * similarity score: Google's suggestion endpoint happily answers "Cambridge"
 * with a list led by whichever it ranks highest, and taking the first would
 * target Cambridgeshire when somebody meant Massachusetts. Nobody reviews a
 * criterion id.
 *
 * EVERY match is returned, including all of them when there are several. The
 * caller decides that several means ambiguous; this function does not choose.
 *
 * @returns {Promise<object[]>} zero, one or many candidates
 */
async function findGeoTargets({ customerId, loginCustomerId = null, name, targetTypes = [], locale = "en", countryCode = "" }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const operation = "geoTarget.find";

  const wanted = str(name);
  if (!wanted) {
    throw fail("VALIDATION", "A location name is needed to look one up.", { field: "name" });
  }

  /* ── THE FILTERS ARE PART OF THE QUERY, NOT APPLIED AFTERWARDS ──────────
     `target_type` narrows a city called X from a region called X, which is the
     commonest kind of ambiguity and the one a caller can actually resolve by
     saying which kind they meant. `status` excludes constants Google has
     scheduled for removal — targeting one is a campaign that stops working on a
     date nobody knows. */
  const clauses = [
    `geo_target_constant.name = '${gaql(wanted)}'`,
    "geo_target_constant.status = 'ENABLED'",
  ];
  if (targetTypes.length) {
    clauses.push(`geo_target_constant.target_type IN (${targetTypes.map((t) => `'${gaql(t)}'`).join(", ")})`);
  }
  if (str(countryCode)) {
    clauses.push(`geo_target_constant.country_code = '${gaql(countryCode).toUpperCase()}'`);
  }

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation,
    query: "SELECT geo_target_constant.id, geo_target_constant.name, "
      + "geo_target_constant.canonical_name, geo_target_constant.country_code, "
      + "geo_target_constant.target_type, geo_target_constant.status "
      + `FROM geo_target_constant WHERE ${clauses.join(" AND ")} LIMIT 25`,
  });

  /* `locale` is accepted so a caller can say which language the NAME is in.
     Google matches `geo_target_constant.name` in English, so it is recorded on
     the request rather than silently ignored, and a non-English locale is
     refused by the resolver rather than answered with an English match. */
  void locale;

  return page.rows
    .map((row) => ({
      criterionId: str(row?.geoTargetConstant?.id),
      resourceName: `geoTargetConstants/${str(row?.geoTargetConstant?.id)}`,
      name: str(row?.geoTargetConstant?.name),
      canonicalName: str(row?.geoTargetConstant?.canonicalName),
      countryCode: str(row?.geoTargetConstant?.countryCode),
      targetType: str(row?.geoTargetConstant?.targetType),
      status: str(row?.geoTargetConstant?.status),
    }))
    .filter((c) => c.criterionId);
}

/**
 * Look up the stable criterion identifier for one language tag.
 *
 * Exact match on Google's own language code, against the bound account, and
 * `targetable` is part of the query — a language constant that exists but
 * cannot be targeted would be accepted here and refused halfway through a
 * creation, after a budget and a campaign already existed.
 */
async function findLanguages({ customerId, loginCustomerId = null, code }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const operation = "language.find";

  const wanted = str(code);
  if (!wanted) {
    throw fail("VALIDATION", "A language code is needed to look one up.", { field: "code" });
  }

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation,
    query: "SELECT language_constant.id, language_constant.code, language_constant.name, "
      + "language_constant.targetable FROM language_constant "
      + `WHERE language_constant.code = '${gaql(wanted)}' AND language_constant.targetable = true LIMIT 25`,
  });

  return page.rows
    .map((row) => ({
      criterionId: str(row?.languageConstant?.id),
      resourceName: `languageConstants/${str(row?.languageConstant?.id)}`,
      code: str(row?.languageConstant?.code),
      name: str(row?.languageConstant?.name),
      targetable: row?.languageConstant?.targetable === true,
    }))
    .filter((c) => c.criterionId);
}

/**
 * Read back the campaign criteria on one campaign.
 *
 * Used to confirm that the targeting GRAV asked for is the targeting the account
 * holds — including that an exclusion was stored as an exclusion. A criterion
 * created with `negative` dropped is an INCLUSION of the one place somebody said
 * to stay out of, and nothing about the create response would show it.
 */
async function readCampaignCriteria({ customerId, loginCustomerId = null, campaignId }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const id = assertDigits(campaignId, "campaignId");

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation: "campaignCriterion.read",
    query: "SELECT campaign_criterion.criterion_id, campaign_criterion.type, "
      + "campaign_criterion.negative, campaign_criterion.location.geo_target_constant, "
      + "campaign_criterion.language.language_constant "
      + `FROM campaign_criterion WHERE campaign.id = ${id}`,
  });

  return page.rows.map((row) => {
    const c = row?.campaignCriterion || {};
    return {
      criterionId: str(c.criterionId),
      type: str(c.type),
      /* Proto3 omits a false boolean, so an absent `negative` IS an inclusion.
         Read as a strict boolean rather than truthiness, because this is the
         field that says whether a place is targeted or avoided. */
      negative: c.negative === true,
      geoTargetConstant: str(c.location?.geoTargetConstant),
      languageConstant: str(c.language?.languageConstant),
    };
  });
}

/**
 * Everything in the bound account carrying one exact GRAV deployment marker.
 *
 * ── THE READ THAT MAKES A LOST RESPONSE RECOVERABLE ────────────────────────
 * A campaign NAME cannot answer "did my request take effect". Names are not
 * unique in Google Ads, a removed campaign keeps its name, and anybody with
 * account access can type one by hand. A marker label is GRAV's own string,
 * unique within the account by Google's constraint, and attached to the
 * campaign inside the same atomic request that created it — so a campaign
 * carrying it exists if and only if that one request succeeded.
 *
 * Returns the whole bundle as the account actually holds it, so the caller can
 * compare every object, every status and every criterion against the command.
 * It returns FACTS, and forms no opinion: deciding whether what came back is a
 * complete bundle is the reconciler's job, not this function's.
 */
async function readBundleByMarker({ customerId, loginCustomerId = null, marker }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");

  const wanted = str(marker);
  if (!wanted) {
    throw fail("VALIDATION", "A deployment marker is needed to look one up.", { field: "marker" });
  }

  const withLogin = loginCustomerId
    ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") }
    : creds;
  /* The bound is part of the query text: v25 refuses a page size. */
  const ask = (operation, query, limit) => search({ env,
    creds: withLogin, token, customerId: account, operation,
    query: `${query} LIMIT ${limit}`,
  });

  /* ── THE LABEL FIRST ────────────────────────────────────────────────────
     Its absence is a real answer: no label means no campaign was ever marked,
     which is what an account looks like after a request that never arrived. */
  const labelPage = await ask("marker.findLabel",
    "SELECT label.id, label.name, label.resource_name, label.status FROM label "
    + `WHERE label.name = '${gaql(wanted)}'`, 5);

  const labels = labelPage.rows
    .map((row) => ({
      labelId: str(row?.label?.id),
      name: str(row?.label?.name),
      resourceName: str(row?.label?.resourceName) || `customers/${account}/labels/${str(row?.label?.id)}`,
      status: str(row?.label?.status),
    }))
    .filter((l) => l.labelId);

  if (!labels.length) {
    return { marker: wanted, labels: [], campaigns: [] };
  }

  /* ── EVERY CAMPAIGN WEARING IT ──────────────────────────────────────────
     Plural on purpose. One is the expected answer; more than one is a real
     situation a person has to look at, and collapsing it to "the newest" is how
     a reconciler adopts somebody else's campaign. */
  const linkPage = await ask("marker.findCampaigns",
    "SELECT campaign_label.campaign, campaign_label.label, campaign.id, campaign.name, "
    + "campaign.status, campaign.advertising_channel_type, campaign.campaign_budget, "
    + "campaign.start_date_time, campaign.end_date_time "
    + `FROM campaign_label WHERE label.name = '${gaql(wanted)}'`, 50);

  const campaigns = [];
  for (const row of linkPage.rows) {
    const c = row?.campaign || {};
    const campaignId = str(c.id);
    if (!campaignId) continue;

    /* The rest of the bundle, per campaign. Sequential because these are reads
       against one rate-limited account and the expected count is one. */
    /* Through the campaign: `campaign_budget` is attributed to `campaign`,
       but a query FROM campaign_budget cannot filter on a campaign. */
    const budgetPage = await ask("marker.readBudget",
      "SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, "
      + "campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.explicitly_shared "
      + `FROM campaign WHERE campaign.id = ${campaignId}`, 5);

    const adGroupPage = await ask("marker.readAdGroups",
      `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId}`, 50);

    const adPage = await ask("marker.readAds",
      "SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.final_urls, "
      + "ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions "
      + `FROM ad_group_ad WHERE campaign.id = ${campaignId}`, 50);

    const keywordPage = await ask("marker.readKeywords",
      "SELECT ad_group_criterion.criterion_id, ad_group_criterion.status, "
      + "ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type "
      + `FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group_criterion.type = 'KEYWORD'`, 200);

    const criterionPage = await ask("marker.readCriteria",
      "SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, "
      + "campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant "
      + `FROM campaign_criterion WHERE campaign.id = ${campaignId}`, 200);

    campaigns.push({
      campaignId,
      name: str(c.name),
      status: str(c.status),
      channelType: str(c.advertisingChannelType),
      budgetResourceName: str(c.campaignBudget),
      /* The calendar day of Google's date-time, as the bundle reconciler
         compares days. */
      startDate: str(c.startDateTime).slice(0, 10),
      endDate: str(c.endDateTime).slice(0, 10),
      labelResourceName: str(row?.campaignLabel?.label),
      budgets: budgetPage.rows.map((r) => ({
        budgetId: str(r?.campaignBudget?.id),
        name: str(r?.campaignBudget?.name),
        amountMicros: Number(r?.campaignBudget?.amountMicros) || null,
        totalAmountMicros: Number(r?.campaignBudget?.totalAmountMicros) || null,
        period: str(r?.campaignBudget?.period),
        explicitlyShared: r?.campaignBudget?.explicitlyShared === true,
      })),
      adGroups: adGroupPage.rows.map((r) => ({
        adGroupId: str(r?.adGroup?.id),
        name: str(r?.adGroup?.name),
        status: str(r?.adGroup?.status),
      })),
      ads: adPage.rows.map((r) => ({
        adId: str(r?.adGroupAd?.ad?.id),
        status: str(r?.adGroupAd?.status),
        finalUrls: Array.isArray(r?.adGroupAd?.ad?.finalUrls) ? r.adGroupAd.ad.finalUrls.map(str) : [],
      })),
      keywords: keywordPage.rows.map((r) => ({
        criterionId: str(r?.adGroupCriterion?.criterionId),
        status: str(r?.adGroupCriterion?.status),
        text: str(r?.adGroupCriterion?.keyword?.text),
        matchType: str(r?.adGroupCriterion?.keyword?.matchType),
      })),
      criteria: criterionPage.rows.map((r) => {
        const cc = r?.campaignCriterion || {};
        return {
          criterionId: str(cc.criterionId),
          type: str(cc.type),
          /* Proto3 omits a false boolean, so an absent `negative` IS an
             inclusion. Read strictly, because this is the field that says
             whether a place is targeted or avoided. */
          negative: cc.negative === true,
          geoTargetConstant: str(cc.location?.geoTargetConstant),
          languageConstant: str(cc.language?.languageConstant),
        };
      }),
    });
  }

  return { marker: wanted, labels, campaigns };
}

/**
 * The lead form attached to one campaign, read back after a creation.
 *
 * ── WHY `campaign_asset` IS FILTERED BY RESOURCE NAME ──────────────────────
 * In v25 `campaign_asset` attributes only `asset` and `customer`, not
 * `campaign`, so `campaign.id` cannot be used here. `campaign_asset.campaign`
 * is itself a filterable resource name, built from digits-only ids.
 *
 * ── WHAT COMES BACK, AND WHAT DOES NOT ─────────────────────────────────────
 * The link's status (the delivery state that matters: PAUSED), its field type,
 * the asset's id and type, and the webhook ADDRESS the form will deliver to —
 * so the caller can prove the form points at GRAV's binding. Google's
 * `google_secret`, if the read echoes it, is dropped here and never leaves this
 * function.
 */
async function readLeadFormLink({ customerId, loginCustomerId = null, campaignId }, env = process.env) {
  const account = assertDigits(customerId, "customerId");
  const id = assertDigits(campaignId, "campaignId");
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  const page = await search({ env,
    creds: loginCustomerId ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") } : creds,
    token, customerId: account, operation: "leadForm.readLink",
    query: "SELECT campaign_asset.resource_name, campaign_asset.status, campaign_asset.field_type, "
      + "asset.id, asset.type, asset.final_urls, asset.lead_form_asset.delivery_methods "
      + `FROM campaign_asset WHERE campaign_asset.campaign = 'customers/${account}/campaigns/${id}' `
      + "AND campaign_asset.field_type = 'LEAD_FORM' LIMIT 10",
  });

  return page.rows.map((row) => {
    const link = row?.campaignAsset || {};
    const asset = row?.asset || {};
    const methods = Array.isArray(asset?.leadFormAsset?.deliveryMethods) ? asset.leadFormAsset.deliveryMethods : [];
    return {
      linkStatus: str(link.status),
      fieldType: str(link.fieldType),
      assetId: typeof asset.id === "string" && /^\d{1,20}$/.test(asset.id) ? asset.id : str(asset.id),
      assetType: str(asset.type),
      /* Addresses only. The secret is not copied out of the row. */
      webhookUrls: methods.map((m) => str(m?.webhook?.advertiserWebhookUrl)).filter(Boolean),
    };
  }).filter((r) => r.assetId);
}

/* ── THE DAILY METRIC SET, AS A CONSTANT ────────────────────────────────────
   Narrower than the aggregate report's. A daily row is read for every day of a
   window, so every extra field is multiplied by the window — and Google will
   happily return search terms, geographic breakdowns and audience segments
   that this chunk does not need and that would then sit in a response body
   somebody later renders. */
const DAILY_METRIC_FIELDS = [
  "segments.date",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
].join(", ");

/**
 * One campaign's metrics, one row per day, against an explicitly named account.
 *
 * ── SEGMENTED, WHICH IS THE WHOLE POINT ────────────────────────────────────
 * `campaignReport` above aggregates a window into a single row. This does not:
 * `segments.date` in the selection makes Google return a row per day, which is
 * what a daily observation needs. Summing an aggregate back into days is
 * impossible, and asking for the window day by day would be one request per
 * day against a rate-limited API.
 *
 * ── AND AN ABSENT METRIC STAYS ABSENT ──────────────────────────────────────
 * Google omits a metric key it has no data for. `Number(undefined)` is `NaN`
 * and `Number(null)` is `0`; both are wrong, and the second is the one that
 * silently reports a campaign as having spent nothing. Every value goes through
 * a strict reader that returns `null` for anything that is not a finite number.
 *
 * @returns {Promise<{currency:string|null, days:object[]}>}
 */
async function campaignDailyReport({ customerId, loginCustomerId = null, campaignId, startDate, endDate }, env = process.env) {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);
  const account = assertDigits(customerId, "customerId");
  const id = assertDigits(campaignId, "campaignId");
  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");
  const operation = "campaign.dailyReport";

  const page = await search({ env,
    creds: loginCustomerId
      ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") }
      : creds,
    token,
    customerId: account,
    operation,
    query: `SELECT ${DAILY_METRIC_FIELDS}, customer.currency_code FROM campaign `
      + `WHERE campaign.id = ${id} AND segments.date BETWEEN '${from}' AND '${to}'`,
  });

  /* A finite number, or null. Never a coercion. */
  const numeric = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let currency = null;
  const days = [];

  for (const row of page.rows) {
    const date = str(row?.segments?.date);
    if (!date) continue;
    currency = currency || str(row?.customer?.currencyCode) || null;
    const m = row?.metrics || {};
    days.push({
      date,
      impressions: numeric(m.impressions),
      clicks: numeric(m.clicks),
      /* Micros, exactly as reported. Converting here would discard a fraction
         of a minor unit per day, and a month of that is a real discrepancy
         against Google's own invoice. */
      costMicros: numeric(m.costMicros),
      conversions: numeric(m.conversions),
      conversionValue: numeric(m.conversionsValue),
      /* Google does not report reach or landing-page views on a Search
         campaign. Absent rather than zero — a zero here would say nobody saw a
         campaign that its own impressions contradict. */
      reach: null,
      landingPageViews: null,
    });
  }

  /* No rows is a real answer: the campaign existed and delivered nothing across
     the window. Distinguished from a failed read by the fact that this returned
     at all — a failure threw. */
  return { currency, days, rowsRead: page.rows.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEAD FORM SUBMISSIONS — GOOGLE'S OWN RECORD OF WHO SUBMITTED
   ═══════════════════════════════════════════════════════════════════════════
   The one read that can bring back an enquiry the webhook never delivered.
   Google keeps these for 60 days; the caller clamps to that.

   ── VERIFIED AGAINST THE v25 FIELD REFERENCE (2026-09-21) ─────────────────
     id                         STRING  selectable, filterable, SORTABLE
     submission_date_time       DATE    selectable, filterable, SORTABLE
                                        "yyyy-mm-dd hh:mm:ss+|-hh:mm"
     campaign, asset            RESOURCE_NAME, filterable (attributed)
     lead_form_submission_fields[]         LeadFormSubmissionField
                                           {field_type, field_value}
     custom_lead_form_submission_fields[]  CustomLeadFormSubmissionField
                                           {question_text, field_value}
     gclid                      STRING  selectable only

   ── THE BOUNDS ARE WHOLE DAYS ─────────────────────────────────────────────
   Google documents date literals as `YYYY-MM-DD` and types this field DATE. A
   time-of-day literal is not documented for it, so none is sent; the caller
   widens by a day at each end (the account's timezone decides where a day
   starts) and deduplication absorbs the overlap.

   ── ORDERED BY (TIME, ID); PAGED BY GOOGLE'S TOKEN ────────────────────────
   Both keys are sortable, so the order is total and stable. GAQL has no OR,
   so "(time, id) after the cursor" cannot be written as a filter: the caller
   compares (time, id) itself. Pages are Google's fixed 10,000 rows — v25
   refuses a page size — continued with `nextPageToken` within one run. */
const LEAD_SUBMISSION_FIELDS = [
  "lead_form_submission_data.id",
  "lead_form_submission_data.submission_date_time",
  "lead_form_submission_data.lead_form_submission_fields",
  "lead_form_submission_data.custom_lead_form_submission_fields",
  "lead_form_submission_data.gclid",
  "lead_form_submission_data.campaign",
  "lead_form_submission_data.asset",
].join(", ");

/* The digits at the end of a resource name — `customers/1/campaigns/2` → `2`.
   Anything else is absent, never guessed. */
const trailingId = (resourceName) => {
  const m = /\/(\d{1,20})$/.exec(str(resourceName));
  return m ? m[1] : "";
};

/* Proto3 JSON to the snake-case shape the shared normaliser already reads,
   so both doors reach GRAV through one function. `id` is a STRING in v25 and
   stays one; nothing here turns a Google id into a number. */
function adaptLeadSubmissionRow(row) {
  const d = row?.leadFormSubmissionData || {};
  const id = typeof d.id === "string" && /^\d{1,20}$/.test(d.id.trim()) ? d.id.trim() : "";
  return {
    id,
    submission_date_time: str(d.submissionDateTime),
    gclid: str(d.gclid),
    campaign_id: trailingId(d.campaign),
    form_id: trailingId(d.asset),
    lead_form_submission_fields: (Array.isArray(d.leadFormSubmissionFields) ? d.leadFormSubmissionFields : [])
      .map((f) => ({ field_type: str(f?.fieldType), field_value: str(f?.fieldValue) })),
    custom_lead_form_submission_fields: (Array.isArray(d.customLeadFormSubmissionFields) ? d.customLeadFormSubmissionFields : [])
      .map((f) => ({ question_text: str(f?.questionText), field_value: str(f?.fieldValue) })),
  };
}

/* Google's page tokens are opaque base64-ish text. Only that alphabet is
   carried back, and only one this client received. */
const PAGE_TOKEN = /^[A-Za-z0-9_\-=+/.]{1,2000}$/;

/**
 * One page of lead form submissions for one campaign, oldest first.
 *
 * @returns {Promise<{rows: object[], nextPageToken: string|null}>}
 */
async function readLeadFormSubmissions({
  customerId, loginCustomerId = null, campaignId, formId = "", fromDate, toDate, pageToken = null,
}, env = process.env) {
  const account = assertDigits(customerId, "customerId");
  const campaign = assertDigits(campaignId, "campaignId");
  const form = str(formId) ? assertDigits(formId, "formId") : "";
  const from = assertDate(fromDate, "fromDate");
  const to = assertDate(toDate, "toDate");
  if (pageToken && !PAGE_TOKEN.test(str(pageToken))) {
    throw fail("VALIDATION", "pageToken is malformed.", { field: "pageToken" });
  }

  const creds = secrets.credentials(CHANNEL, env);
  const token = await accessToken(creds);

  const where = [
    `lead_form_submission_data.campaign = 'customers/${account}/campaigns/${campaign}'`,
    ...(form ? [`lead_form_submission_data.asset = 'customers/${account}/assets/${form}'`] : []),
    `lead_form_submission_data.submission_date_time >= '${from}'`,
    `lead_form_submission_data.submission_date_time <= '${to}'`,
  ].join(" AND ");

  const page = await search({ env,
    creds: loginCustomerId
      ? { ...creds, loginCustomerId: assertDigits(loginCustomerId, "loginCustomerId") }
      : creds,
    token,
    customerId: account,
    operation: "leadForm.readSubmissions",
    pageToken: pageToken ? str(pageToken) : null,
    query: `SELECT ${LEAD_SUBMISSION_FIELDS} FROM lead_form_submission_data WHERE ${where} `
      + "ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC",
  });

  return {
    rows: page.rows.map(adaptLeadSubmissionRow).filter((r) => r.id),
    nextPageToken: page.nextPageToken,
  };
}

module.exports = {
  CHANNEL,
  API_VERSION,
  API_VERSION_SUPPORTED: googleApi.VERSIONS,
  accessibleAccounts,
  verifyAccount,
  verifyReporting,
  listCampaigns,
  campaignReport,
  campaignDailyReport,

  /* Explicit-account reads, used by the deployment path. */
  describeAccount,
  findCampaignsByName,
  findGeoTargets,
  findLanguages,
  readBundleByMarker,
  readCampaignCriteria,
  hasConversionAction,
  readDeliveryStates,
  readLeadFormSubmissions,
  readLeadFormLink,
  /* Exported for tests only, so a suite can prove a forged value never reaches a
     query. Not used by any service or route. */
  __test: {
    assertDigits, assertDate, STATUS_FILTER, tokenCache, adaptLeadSubmissionRow,
    /* The write client needs a token and must not have its own refresh path:
       two caches would double the refresh traffic and could disagree about
       which token is current. Exposed here rather than made a public export,
       because nothing outside these two files may ask for one. */
    accessTokenFor: accessToken,
  },
};
