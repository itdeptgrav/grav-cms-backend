// test/marketing/google-ads-v25-contract.test.js
//
// THE GOOGLE ADS CLIENT, PROVED AGAINST THE v25 CONTRACT — NOT AGAINST ITSELF.
//
// Every earlier suite accepted whatever query the client happened to send, so
// a client speaking a sunset version, sending a removed field (`pageSize`),
// selecting a removed field (`campaign.start_date`) and querying resources that
// do not exist (`FROM audience_group`) passed every test. These assertions are
// written from Google's v25 reference (read 2026-09-21), and pin the exact
// bytes: URL, method, headers, query text and body.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

jest.mock("axios");

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const googleApi = require("../../constants/marketingGoogleAdsApi");
const googleAds = require("../../services/marketing/channels/googleAdsClient");
const bundle = require("../../services/marketing/channels/googleSearchBundle");
const secrets = require("../../services/marketing/channels/channelSecrets");
const mapper = require("../../services/marketing/deployment/googleSearchMapper");
const { normalise } = require("../../services/marketing/leads/googleLeadNormalisation");

const ROOT = path.join(__dirname, "..", "..");
const V = googleApi.SELECTED_VERSION;
const BASE = `https://googleads.googleapis.com/${V}`;
const ACCT = "1234567890";
const MANAGER = "9998887776";

/* ── THE FAKE GOOGLE ──────────────────────────────────────────────────────── */
let calls = [];
let responder = () => ({ status: 200, data: { results: [] } });

const ENV = [
  "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_API_VERSION",
];
const saved = {};

beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, {
    GOOGLE_ADS_CLIENT_ID: "gid", GOOGLE_ADS_CLIENT_SECRET: "gsecret",
    GOOGLE_ADS_REFRESH_TOKEN: "grefresh", GOOGLE_ADS_CUSTOMER_ID: ACCT,
  });
  googleAds.__test.tokenCache.clear();
  calls = [];
  responder = () => ({ status: 200, data: { results: [] } });
  axios.mockImplementation(async (config) => {
    calls.push(config);
    if (String(config.url).includes("oauth2.googleapis.com/token")) {
      return { status: 200, data: { access_token: "access-token-value", expires_in: 3600 } };
    }
    return responder(config);
  });
});

const searches = () => calls.filter((c) => String(c.url).includes("googleAds:search"));
const lastSearch = () => searches().pop();

/* A GoogleAdsFailure error body, exactly as the REST interface returns one. */
const failure = (httpCode, family, value) => ({
  status: httpCode,
  data: {
    error: {
      code: httpCode,
      message: "Request contains an invalid argument.",
      status: httpCode === 403 ? "PERMISSION_DENIED" : httpCode === 401 ? "UNAUTHENTICATED" : "INVALID_ARGUMENT",
      details: [{
        "@type": `type.googleapis.com/google.ads.googleads.${V}.errors.GoogleAdsFailure`,
        errors: [{ errorCode: { [family]: value }, message: `customers/${ACCT} said no` }],
        requestId: "req-1",
      }],
    },
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. ONE VERSION, AND IT IS A SUPPORTED ONE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the API version", () => {
  /* Every executable file that could talk to Google Ads. */
  const EXECUTABLE = () => {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) out.push(rel);
      }
    };
    ["services", "routes", "constants", "Middlewear", "middleware", "utils", "config"].forEach((d) => {
      if (fs.existsSync(path.join(ROOT, d))) walk(d);
    });
    return out;
  };
  const code = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("1. no executable file targets v18, or any sunset version, of Google Ads", () => {
    for (const file of EXECUTABLE()) {
      const src = code(file);
      if (!/googleads|googleAds|google_ads/i.test(src)) continue;
      for (const v of googleApi.SUNSET_VERSIONS) {
        if (file === path.join("constants", "marketingGoogleAdsApi.js")) continue;
        expect({ file, hit: new RegExp(`["'\`/]${v}["'\`/]`).test(src) }).toEqual({ file, hit: false });
      }
    }
  });

  test("2. exactly one file builds a Google Ads base URL; no service constructs its own", () => {
    const building = EXECUTABLE().filter((f) => /googleads\.googleapis\.com/.test(code(f)));
    expect(building).toEqual([path.join("constants", "marketingGoogleAdsApi.js")]);
  });

  test("3. the selected version is explicitly supported, and both clients speak it", () => {
    expect(V).toBe("v25");
    expect(Object.keys(googleApi.VERSIONS)).toContain(V);
    expect(googleApi.isSupported(V)).toBe(true);
    expect(googleAds.API_VERSION).toBe(V);
    expect(bundle.API_VERSION).toBe(V);
    expect(googleApi.apiBase({})).toBe(BASE);
  });

  test("4. a version outside the supported set is refused before anything is sent — never a fallback", async () => {
    expect(googleApi.isSupported("v18")).toBe(false);
    expect(googleApi.isSupported("v99")).toBe(false);
    /* v22's sunset month begins 2026-10-01. */
    expect(googleApi.isSupported("v22", new Date("2026-09-30T12:00:00Z"))).toBe(true);
    expect(googleApi.isSupported("v22", new Date("2026-10-01T00:00:00Z"))).toBe(false);
    expect(() => googleApi.resolveVersion({ GOOGLE_ADS_API_VERSION: "v18" })).toThrow(/not supported/);

    process.env.GOOGLE_ADS_API_VERSION = "v18";
    await expect(googleAds.verifyAccount()).rejects.toMatchObject({ code: "CHANNEL_API_VERSION_REJECTED" });
    await expect(googleAds.accessibleAccounts()).rejects.toMatchObject({ code: "CHANNEL_API_VERSION_REJECTED" });
    expect(calls.filter((c) => String(c.url).includes("googleads"))).toHaveLength(0);
  });

  test("5. every request in one session goes to the same major version", async () => {
    await googleAds.verifyAccount();
    await googleAds.hasConversionAction({ customerId: ACCT });
    await googleAds.accessibleAccounts().catch(() => {});
    const majors = new Set(calls.filter((c) => String(c.url).includes("googleads"))
      .map((c) => String(c.url).match(/googleapis\.com\/(v\d+)\//)[1]));
    expect([...majors]).toEqual([V]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. AUTHENTICATION AS OF 2026-09-21
   ═══════════════════════════════════════════════════════════════════════════ */

describe("authentication", () => {
  test("6. OAuth refresh: the documented token exchange, form-encoded, never retried", async () => {
    await googleAds.verifyAccount();
    const token = calls.find((c) => String(c.url).includes("oauth2.googleapis.com/token"));
    expect(token.method).toBe("POST");
    expect(token.url).toBe("https://oauth2.googleapis.com/token");
    expect(token.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.data);
    expect(Object.fromEntries(form)).toEqual({
      client_id: "gid", client_secret: "gsecret", refresh_token: "grefresh", grant_type: "refresh_token",
    });
  });

  test("7. requests carry the bearer token and no developer token; the token is not a required variable", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "legacy-dev-token";
    await googleAds.verifyAccount();
    const h = lastSearch().headers;
    expect(h.Authorization).toBe("Bearer access-token-value");
    expect(h).not.toHaveProperty("developer-token");
    expect(JSON.stringify(calls)).not.toContain("legacy-dev-token");

    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const presence = secrets.presence("google_ads");
    expect(presence.configured).toBe(true);
    expect(secrets.CHANNEL_SECRETS.google_ads.required).not.toContain("GOOGLE_ADS_DEVELOPER_TOKEN");
  });

  test("8. manager-account scoping: login-customer-id only when a manager is bound", async () => {
    responder = () => ({ status: 200, data: { results: [{ customer: { id: ACCT, currencyCode: "INR" } }] } });
    await googleAds.describeAccount({ customerId: ACCT });
    expect(lastSearch().headers).not.toHaveProperty("login-customer-id");
    await googleAds.describeAccount({ customerId: ACCT, loginCustomerId: MANAGER });
    expect(lastSearch().headers["login-customer-id"]).toBe(MANAGER);
    /* The account being read is in the URL; the manager is only a header. */
    expect(lastSearch().url).toBe(`${BASE}/customers/${ACCT}/googleAds:search`);
  });

  test("9. the six access states are told apart", async () => {
    /* An Ads-API refusal answers only the Ads endpoint; the token exchange
       still succeeds. */
    const ads = (resp) => (c) => (String(c.url).includes("googleAds") ? resp() : null);
    const cases = [
      /* OAuth credential unavailable: not configured at all … */
      [() => { delete process.env.GOOGLE_ADS_REFRESH_TOKEN; }, null, "CHANNEL_NOT_CONFIGURED"],
      /* … or refused by Google's token endpoint … */
      [null, (c) => (String(c.url).includes("oauth2") ? { status: 400, data: { error: "invalid_grant" } } : null), "CHANNEL_OAUTH_UNAVAILABLE"],
      /* … or refused by the Ads API itself. */
      [null, ads(() => failure(401, "authenticationError", "OAUTH_TOKEN_EXPIRED")), "CHANNEL_OAUTH_UNAVAILABLE"],
      /* API access (the Cloud project) unavailable. */
      [null, ads(() => failure(403, "authorizationError", "PROJECT_DISABLED")), "CHANNEL_API_ACCESS_UNAVAILABLE"],
      [null, ads(() => failure(403, "authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION")), "CHANNEL_API_ACCESS_UNAVAILABLE"],
      /* Manager / account binding unavailable. */
      [null, ads(() => failure(403, "authorizationError", "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION")), "CHANNEL_ACCOUNT_BINDING_UNAVAILABLE"],
      [null, ads(() => failure(400, "authenticationError", "CUSTOMER_NOT_FOUND")), "CHANNEL_ACCOUNT_BINDING_UNAVAILABLE"],
      /* Permission refused. */
      [null, ads(() => failure(403, "authorizationError", "USER_PERMISSION_DENIED")), "CHANNEL_ACCESS_REFUSED"],
      /* API version rejected. */
      [null, ads(() => ({ status: 404, data: "<html>Not Found</html>" })), "CHANNEL_API_VERSION_REJECTED"],
      [null, ads(() => failure(400, "requestError", "PAGE_SIZE_NOT_SUPPORTED")), "CHANNEL_API_VERSION_REJECTED"],
      /* Provider temporarily unavailable (retried, then reported). */
      [null, ads(() => ({ status: 503, data: {} })), "CHANNEL_UNAVAILABLE"],
    ];

    for (const [setup, answer, expected] of cases) {
      googleAds.__test.tokenCache.clear();
      if (setup) setup();
      if (answer) {
        axios.mockImplementation(async (config) => {
          calls.push(config);
          const special = answer(config);
          if (special && (String(config.url).includes("oauth2") || String(config.url).includes("googleAds"))) return special;
          if (String(config.url).includes("oauth2")) return { status: 200, data: { access_token: "t", expires_in: 3600 } };
          return special || { status: 200, data: { results: [] } };
        });
      }
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      // eslint-disable-next-line no-await-in-loop
      const err = await googleAds.verifyAccount().then(() => null, (e) => e);
      spy.mockRestore();
      expect({ expected, got: err?.code }).toEqual({ expected, got: expected });
      /* None of them carries Google's words, or the account. */
      expect(String(err?.message)).not.toMatch(/customers\/|invalid argument|said no/);
      process.env.GOOGLE_ADS_REFRESH_TOKEN = "grefresh";
    }
  }, 30000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. EVERY CLOSED READ, BYTE FOR BYTE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the closed reads", () => {
  const exactSearch = (query, { pageToken } = {}) => {
    const c = lastSearch();
    expect(c.method).toBe("POST");
    expect(c.data).toEqual(pageToken ? { query, pageToken } : { query });
    return c;
  };

  test("10. account listing: GET customers:listAccessibleCustomers, no body", async () => {
    responder = () => ({ status: 200, data: { resourceNames: [`customers/${ACCT}`] } });
    expect(await googleAds.accessibleAccounts()).toEqual([ACCT]);
    const c = calls.find((x) => String(x.url).includes("listAccessibleCustomers"));
    expect(c.method).toBe("GET");
    expect(c.url).toBe(`${BASE}/customers:listAccessibleCustomers`);
    expect(c.data).toBeUndefined();
  });

  test("11. account verification and description", async () => {
    responder = () => ({ status: 200, data: { results: [{ customer: { id: ACCT, currencyCode: "INR", timeZone: "Asia/Kolkata", manager: false, testAccount: false, status: "ENABLED" } }] } });
    await googleAds.verifyAccount();
    exactSearch("SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1");
    const d = await googleAds.describeAccount({ customerId: ACCT });
    exactSearch("SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status, customer.test_account FROM customer LIMIT 1");
    expect(d).toMatchObject({ accountId: ACCT, currency: "INR", isManager: false });
  });

  test("12. campaign listing: v25 date-time fields, keyset on campaign.id, no page size", async () => {
    responder = () => ({ status: 200, data: { results: [
      { campaign: { id: "11", name: "A", status: "ENABLED", startDateTime: "2026-10-01 00:00:00", endDateTime: "2026-12-15 23:59:59" }, customer: { currencyCode: "INR" } },
      { campaign: { id: "12", name: "B", status: "PAUSED" }, customer: { currencyCode: "INR" } },
    ] } });
    const page = await googleAds.listCampaigns({ pageSize: 1 });
    exactSearch("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, "
      + "campaign.start_date_time, campaign.end_date_time, campaign_budget.amount_micros, "
      + "campaign_budget.total_amount_micros, customer.currency_code FROM campaign "
      + "WHERE campaign.status != 'REMOVED' ORDER BY campaign.id ASC LIMIT 2");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ providerCampaignId: "11", startDate: "2026-10-01", endDate: "2026-12-15" });
    expect(page.nextPageToken).toBe("gc1:11");

    await googleAds.listCampaigns({ status: "paused", pageSize: 1, pageToken: page.nextPageToken });
    exactSearch("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, "
      + "campaign.start_date_time, campaign.end_date_time, campaign_budget.amount_micros, "
      + "campaign_budget.total_amount_micros, customer.currency_code FROM campaign "
      + "WHERE campaign.status = 'PAUSED' AND campaign.id > 11 ORDER BY campaign.id ASC LIMIT 2");

    await expect(googleAds.listCampaigns({ pageToken: "gc1:1 OR 1=1" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("13. campaign reports: aggregate and daily", async () => {
    await googleAds.campaignReport({ providerCampaignId: "11", startDate: "2026-09-01", endDate: "2026-09-07" });
    exactSearch("SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, "
      + "metrics.conversions, customer.currency_code FROM campaign "
      + "WHERE campaign.id = 11 AND segments.date BETWEEN '2026-09-01' AND '2026-09-07'");
    await googleAds.campaignDailyReport({ customerId: ACCT, campaignId: "11", startDate: "2026-09-01", endDate: "2026-09-07" });
    exactSearch("SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, "
      + "metrics.conversions, metrics.conversions_value, customer.currency_code FROM campaign "
      + "WHERE campaign.id = 11 AND segments.date BETWEEN '2026-09-01' AND '2026-09-07'");
  });

  test("14. reporting verification, conversion verification and name lookup", async () => {
    await googleAds.verifyReporting();
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    exactSearch(`SELECT campaign.id, metrics.impressions FROM campaign WHERE segments.date BETWEEN '${day}' AND '${day}' LIMIT 1`);
    await googleAds.hasConversionAction({ customerId: ACCT });
    exactSearch("SELECT conversion_action.id, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED' LIMIT 1");
    await googleAds.findCampaignsByName({ customerId: ACCT, name: "O'Brien winter" });
    exactSearch("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.name = 'O\\'Brien winter' LIMIT 50");
  });

  test("15. no read sends a page size, anywhere", async () => {
    await googleAds.verifyAccount();
    await googleAds.listCampaigns({ pageSize: 5 });
    await googleAds.findGeoTargets({ customerId: ACCT, name: "India" });
    await googleAds.findLanguages({ customerId: ACCT, code: "en" });
    await googleAds.readDeliveryStates({ customerId: ACCT, campaignId: "11" });
    await googleAds.readBundleByMarker({ customerId: ACCT, marker: "GRAV-M-1" });
    for (const c of searches()) expect(c.data).not.toHaveProperty("pageSize");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. GRAV'S ROLES, GOOGLE'S RESOURCES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("delivery states", () => {
  test("16. the five GRAV roles map to real Google resources", () => {
    expect(googleApi.ROLE_TO_RESOURCE).toEqual({
      budget: "campaign_budget",
      campaign: "campaign",
      audience_group: "ad_group",
      advertisement: "ad_group_ad",
      targeting_term: "ad_group_criterion",
    });
    expect(googleApi.ROLE_HAS_DELIVERY_STATUS.budget).toBe(false);
  });

  test("17. the stopped-state reads name only Google resources, and the budget is not given a delivery status", async () => {
    responder = (c) => {
      const q = String(c.data?.query);
      if (q.includes("FROM campaign WHERE")) {
        return { status: 200, data: { results: [{
          campaign: { id: "11", status: "PAUSED" },
          campaignBudget: { id: "77", status: "ENABLED", amountMicros: "250000000", period: "DAILY" },
        }] } };
      }
      if (q.includes("FROM ad_group WHERE")) return { status: 200, data: { results: [{ adGroup: { id: "21", status: "PAUSED" } }] } };
      if (q.includes("FROM ad_group_ad WHERE")) return { status: 200, data: { results: [{ adGroupAd: { ad: { id: "31" }, status: "PAUSED" } }] } };
      if (q.includes("FROM ad_group_criterion WHERE")) return { status: 200, data: { results: [{ adGroupCriterion: { criterionId: "41", status: "PAUSED" } }] } };
      return { status: 200, data: { results: [] } };
    };
    const states = await googleAds.readDeliveryStates({ customerId: ACCT, campaignId: "11" });

    expect(searches().map((c) => c.data.query)).toEqual([
      "SELECT campaign.id, campaign.status, campaign_budget.id, campaign_budget.status, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period FROM campaign WHERE campaign.id = 11 LIMIT 1",
      "SELECT ad_group.id, ad_group.status FROM ad_group WHERE campaign.id = 11",
      "SELECT ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad WHERE campaign.id = 11",
      "SELECT ad_group_criterion.criterion_id, ad_group_criterion.status FROM ad_group_criterion WHERE campaign.id = 11 AND ad_group_criterion.type = 'KEYWORD'",
    ]);
    /* The provider-neutral result the orchestrator reads is unchanged. */
    expect(states.map((s) => [s.role, s.providerObjectId, s.status])).toEqual([
      ["campaign", "11", "PAUSED"],
      ["audience_group", "21", "PAUSED"],
      ["advertisement", "31", "PAUSED"],
      ["targeting_term", "41", "PAUSED"],
    ]);
    expect(states.map((s) => s.role)).not.toContain("budget");
    expect(states.budgets).toEqual([{
      role: "budget", providerObjectId: "77", exists: true,
      amountMicros: "250000000", totalAmountMicros: null, period: "DAILY", deliveryStateApplies: false,
    }]);
  });

  test("18. no query anywhere names a GRAV role as a Google resource", async () => {
    await googleAds.readDeliveryStates({ customerId: ACCT, campaignId: "11" });
    await googleAds.readBundleByMarker({ customerId: ACCT, marker: "GRAV-M-1" });
    /* Code only: the file's own comments explain the old mistake by name. */
    const src = fs.readFileSync(path.join(ROOT, "services/marketing/channels/googleAdsClient.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const role of ["audience_group", "advertisement", "targeting_term"]) {
      for (const c of searches()) expect(c.data.query).not.toMatch(new RegExp(`\\b${role}\\.|FROM ${role}\\b`));
      expect(src).not.toMatch(new RegExp(`FROM ${role}\\b`));
    }
    /* And a budget is never read FROM campaign_budget filtered by a campaign:
       campaign is not an attributed resource of campaign_budget. */
    for (const c of searches()) expect(c.data.query).not.toMatch(/FROM campaign_budget WHERE campaign\./);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. LEAD FORM SUBMISSIONS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("lead_form_submission_data", () => {
  /* A v25 GoogleAdsRow, shaped as the REST interface returns it: camelCase,
     `id` a STRING (as the v25 field reference types it), resource names for
     campaign and asset, and custom answers with no field type. */
  const contractRow = (over = {}) => ({
    leadFormSubmissionData: {
      resourceName: `customers/${ACCT}/leadFormSubmissionData/9007199254740993`,
      id: "9007199254740993",
      submissionDateTime: "2026-09-20 15:30:00+05:30",
      gclid: "gclid-abc",
      campaign: `customers/${ACCT}/campaigns/9876543210123`,
      asset: `customers/${ACCT}/assets/5550001112223`,
      leadFormSubmissionFields: [
        { fieldType: "FULL_NAME", fieldValue: "R Sharma" },
        { fieldType: "EMAIL", fieldValue: "r.sharma@acme.in" },
      ],
      customLeadFormSubmissionFields: [{ questionText: "Which industry?", fieldValue: "Hospitality" }],
      ...over,
    },
  });

  test("19. one fixed query, whole-day bounds, (time, id) order, no page size", async () => {
    responder = () => ({ status: 200, data: { results: [contractRow()], nextPageToken: "CPii5aS87vfFTBAKGJvk-_8B" } });
    const page = await googleAds.readLeadFormSubmissions({
      customerId: ACCT, loginCustomerId: MANAGER, campaignId: "9876543210123", formId: "5550001112223",
      fromDate: "2026-07-20", toDate: "2026-09-23",
    });

    const c = lastSearch();
    expect(c.url).toBe(`${BASE}/customers/${ACCT}/googleAds:search`);
    expect(c.headers["login-customer-id"]).toBe(MANAGER);
    expect(c.data).toEqual({
      query: "SELECT lead_form_submission_data.id, lead_form_submission_data.submission_date_time, "
        + "lead_form_submission_data.lead_form_submission_fields, "
        + "lead_form_submission_data.custom_lead_form_submission_fields, lead_form_submission_data.gclid, "
        + "lead_form_submission_data.campaign, lead_form_submission_data.asset "
        + "FROM lead_form_submission_data "
        + `WHERE lead_form_submission_data.campaign = 'customers/${ACCT}/campaigns/9876543210123' `
        + `AND lead_form_submission_data.asset = 'customers/${ACCT}/assets/5550001112223' `
        + "AND lead_form_submission_data.submission_date_time >= '2026-07-20' "
        + "AND lead_form_submission_data.submission_date_time <= '2026-09-23' "
        + "ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC",
    });

    /* Int64-safe: 2^53 + 1 survives because it never became a number. */
    expect(page.rows[0].id).toBe("9007199254740993");
    expect(page.nextPageToken).toBe("CPii5aS87vfFTBAKGJvk-_8B");
    const lead = normalise({ via: "retrieval", payload: page.rows[0] }).lead;
    expect(lead.providerLeadId).toBe("9007199254740993");
    expect(lead.correlation).toMatchObject({ campaignId: "9876543210123", formId: "5550001112223" });
    expect(lead.contact).toEqual({ fullName: "R Sharma", email: "r.sharma@acme.in" });
    expect(lead.unmapped.map((u) => [u.code, u.answer])).toEqual([["CUSTOM_QUESTION", "Hospitality"]]);
    expect(lead.submittedAt).toBe("2026-09-20T10:00:00.000Z");
  });

  test("20. Google's page token is carried back verbatim in the body, and nothing else is added", async () => {
    await googleAds.readLeadFormSubmissions({
      customerId: ACCT, campaignId: "9876543210123", fromDate: "2026-07-20", toDate: "2026-09-23",
      pageToken: "CPii5aS87vfFTBAKGJvk-_8B",
    });
    expect(Object.keys(lastSearch().data).sort()).toEqual(["pageToken", "query"]);
    expect(lastSearch().data.pageToken).toBe("CPii5aS87vfFTBAKGJvk-_8B");
    /* Without a form, the asset clause is absent rather than empty. */
    expect(lastSearch().data.query).not.toMatch(/\.asset =/);
  });

  test("21. an id that is not a digit string is dropped, never coerced", async () => {
    responder = () => ({ status: 200, data: { results: [contractRow({ id: 12345 }), contractRow({ id: "abc" }), contractRow()] } });
    const page = await googleAds.readLeadFormSubmissions({
      customerId: ACCT, campaignId: "9876543210123", fromDate: "2026-07-20", toDate: "2026-09-23",
    });
    expect(page.rows.map((r) => r.id)).toEqual(["9007199254740993"]);
  });

  test("22. no caller-supplied value can become query text", async () => {
    const base = { customerId: ACCT, campaignId: "9876543210123", fromDate: "2026-07-20", toDate: "2026-09-22" };
    for (const bad of [
      { campaignId: "1 OR 1=1" },
      { formId: "5' OR '1'='1" },
      { customerId: "123/../456" },
      { fromDate: "2026-02-31" },
      { toDate: "2026-09-22' OR" },
      { pageToken: "abc' OR 1=1" },
      { loginCustomerId: "1; DROP" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(googleAds.readLeadFormSubmissions({ ...base, ...bad })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(searches()).toHaveLength(0);
    /* And there is no generic query function to call instead. */
    expect(Object.keys(googleAds)).not.toEqual(expect.arrayContaining(["search"]));
    expect(Object.keys(googleAds).filter((k) => /^(search|query|run|raw|request)/i.test(k))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. THE WRITE BUNDLE, STRUCTURALLY (NOTHING IS SENT TO GOOGLE)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the atomic mutate bundle against v25", () => {
  const BRIEF = {
    channel: "google_ads",
    campaignType: "google_search",
    destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
    geoTargeting: [{ name: "India", kind: "country" }],
    geoExclusions: [{ name: "Goa", kind: "region" }],
    languages: ["en"],
    audiences: [],
    exclusionDecision: "none_required",
    exclusions: [],
    bidding: { strategy: "target_cost_per_click", target: { amount: 12.5, currency: "INR" } },
    budgetRelationship: "campaign_daily",
    euPoliticalAdvertising: "does_not_contain",
    googleSearch: {
      headlines: ["Winter uniforms", "Hotel uniforms", "Bulk orders"],
      descriptions: ["Made to measure for hospitality.", "Delivered across India."],
      keywordThemes: ["hotel uniforms", "hospital uniforms"],
    },
    timezone: "Asia/Kolkata",
  };
  const plan = (briefOver = {}) => ({
    _id: "650000000000000000000001",
    draftRef: "MCP-2026-0001",
    name: "Winter uniforms",
    revision: 3,
    state: "approved",
    utmCampaign: "winter-uniforms",
    schedule: { startDate: "2026-10-01", endDate: "2026-12-15" },
    budget: { amount: 2500, currency: "INR", basis: "daily" },
    deploymentBriefs: [{ ...BRIEF, ...briefOver }],
  });
  const targeting = (p) => ({
    resolvedFor: {
      campaignDraftId: String(p._id), draftRef: p.draftRef, approvedRevision: p.revision,
      externalAccountId: ACCT, bindingId: "", bindingRevision: 0,
    },
    locations: [{ requested: { name: "India", kind: "country" }, outcome: "resolved", criterionId: "2356", resourceName: "geoTargetConstants/2356", canonicalName: "India" }],
    exclusions: [{ requested: { name: "Goa", kind: "region" }, outcome: "resolved", criterionId: "20981", resourceName: "geoTargetConstants/20981", canonicalName: "Goa,India" }],
    languages: [{ requested: { tag: "en" }, outcome: "resolved", criterionId: "1000", resourceName: "languageConstants/1000", canonicalName: "English" }],
    complete: true, blockers: [], fingerprint: "fp",
  });
  const account = { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCT };
  const build = (briefOver = {}) => {
    const p = plan(briefOver);
    const out = mapper.map({ plan: p, account, resolvedTargeting: targeting(p) });
    expect(out.problems).toEqual([]);
    const built = bundle.buildBundle({ customerId: ACCT, marker: "GRAV-D1-0123456789abcdef0123456789abcdef", mapping: out.mapping, resolvedTargeting: targeting(p) });
    bundle.assertBundleIntegrity({ operations: built.operations, account: ACCT, targeting: targeting(p) });
    return built.operations;
  };
  const creates = (ops, key) => ops.filter((o) => o[key]).map((o) => o[key].create);

  test("23. only v25 mutate operations, only `create`, only fields v25 defines", () => {
    const ops = build();
    for (const op of ops) {
      const [key] = Object.keys(op);
      expect(bundle.ALLOWED_OPERATION_KEYS).toContain(key);
      expect(Object.keys(op[key])).toEqual(["create"]);
      for (const f of Object.keys(op[key].create)) expect(bundle.ALLOWED_CREATE_FIELDS[key]).toContain(f);
    }
  });

  test("24. the campaign carries v25's date-time fields, the EU declaration, and PAUSED", () => {
    const [campaign] = creates(build(), "campaignOperation");
    expect(campaign).toMatchObject({
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      startDateTime: "2026-10-01 00:00:00",
      endDateTime: "2026-12-15 23:59:59",
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      manualCpc: { enhancedCpcEnabled: false },
    });
    expect(campaign).not.toHaveProperty("startDate");
    expect(campaign).not.toHaveProperty("endDate");
  });

  test("25. no EU declaration, no campaign — GRAV never answers it for the advertiser", () => {
    const p = plan({ euPoliticalAdvertising: "" });
    const out = mapper.map({ plan: p, account, resolvedTargeting: targeting(p) });
    expect(out.mappable).toBe(false);
    expect(out.problems.map((x) => x.code)).toContain("EU_POLITICAL_DECLARATION_MISSING");

    const good = build();
    const stripped = good.map((op) => (op.campaignOperation
      ? { campaignOperation: { create: { ...op.campaignOperation.create, containsEuPoliticalAdvertising: undefined } } }
      : op));
    expect(() => bundle.assertBundleIntegrity({ operations: stripped, account: ACCT, targeting: targeting(plan()) }))
      .toThrow(/EU political-advertising declaration/);
  });

  test("26. int64 amounts travel as digit strings; a manual-CPC bid lands on the ad group", () => {
    const ops = build();
    const [budget] = creates(ops, "campaignBudgetOperation");
    expect(budget.amountMicros).toBe("2500000000");
    expect(budget).not.toHaveProperty("totalAmountMicros");
    const [adGroup] = creates(ops, "adGroupOperation");
    expect(adGroup.cpcBidMicros).toBe("12500000");
    expect(adGroup.status).toBe("PAUSED");
  });

  test("27. a lifetime budget sends total_amount_micros, never the daily field", () => {
    const [budget] = creates(build({ budgetRelationship: "campaign_total" }), "campaignBudgetOperation");
    expect(budget).toMatchObject({ period: "CUSTOM_PERIOD", totalAmountMicros: "2500000000" });
    expect(budget).not.toHaveProperty("amountMicros");
  });

  test("28. temporary resource names only where a later operation refers to them", () => {
    const ops = build();
    const named = ops.map((op) => {
      const [key] = Object.keys(op);
      return [key, op[key].create.resourceName || null];
    });
    for (const [key, name] of named) {
      if (["labelOperation", "campaignBudgetOperation", "campaignOperation", "adGroupOperation"].includes(key)) {
        expect(name).toMatch(new RegExp(`^customers/${ACCT}/(labels|campaignBudgets|campaigns|adGroups)/-\\d+$`));
      } else {
        /* Composite resources (`{parent}~{id}`): no bare negative id is sent. */
        expect(name).toBeNull();
      }
    }
    /* Keywords and ads are stopped; campaign criteria have no status at all. */
    for (const c of creates(ops, "adGroupAdOperation")) expect(c.status).toBe("PAUSED");
    for (const c of creates(ops, "adGroupCriterionOperation")) expect(c.status).toBe("PAUSED");
    for (const c of creates(ops, "campaignCriterionOperation")) expect(c).not.toHaveProperty("status");
  });

  test("29. the mutate request: v25 URL, no requestId, no developer token, partial failure off", async () => {
    const p = plan();
    const out = mapper.map({ plan: p, account, resolvedTargeting: targeting(p) });
    const sent = [];
    await bundle.createPausedAtomic({
      customerId: ACCT, marker: "GRAV-D1-0123456789abcdef0123456789abcdef", mapping: out.mapping,
      resolvedTargeting: targeting(p), requestId: "attempt-1", validateOnly: true,
    }, {
      transport: async (req) => { sent.push(req); return { data: {} }; },
      authorise: async () => ({ creds: { developerToken: "legacy" }, token: "t" }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${BASE}/customers/${ACCT}/googleAds:mutate`);
    expect(Object.keys(sent[0].data).sort()).toEqual(["mutateOperations", "partialFailure", "validateOnly"]);
    expect(sent[0].data.partialFailure).toBe(false);
    expect(sent[0].headers).not.toHaveProperty("developer-token");
  });

  test("30. no update, remove, enable or activation operation exists anywhere in the write path", () => {
    const src = fs.readFileSync(path.join(ROOT, "services/marketing/channels/googleSearchBundle.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b(update|remove)\s*:/);
    expect(src).not.toMatch(/["']ENABLED["']/);
    expect(src).not.toMatch(/\bactivate\w*\s*\(/i);
    for (const op of build()) {
      const [key] = Object.keys(op);
      expect(Object.keys(op[key])).toEqual(["create"]);
    }
  });
});
