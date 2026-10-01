// test/marketing/advertising-channels.test.js
//
// REAL ADVERTISING CHANNEL INTEGRATION: CONNECTION, INVENTORY, PERFORMANCE.
//
// ── THE TRANSPORT IS MOCKED, NOT THE ADAPTERS ──────────────────────────────
// `axios` is replaced and nothing else is. So every test below exercises the
// real adapter, the real status mapping, the real retry budget, the real
// normalisation and the real route — and the provider is the only fiction.
//
// Mocking the adapters instead would have been easier and would have proved
// almost nothing: the bugs this contract exists to prevent all live in that
// code. A 403 becoming an empty list, a timeout becoming zero spend, micros
// divided by the wrong power of ten, an absent metric arriving as `Number(null)`
// — every one of those is in a layer a mocked adapter would have replaced.
//
// It also lets the suite assert what GRAV SENT: that no request uses a write
// verb, and that the access token is never in a query string.
"use strict";

jest.mock("axios");

/* The middleware itself has its own suite and needs a signed token. Replaced
   with one that honours the same role rule, so a role test here is still a real
   role test. */
jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const directory = require("../../services/marketing/channels/channelDirectory.service");
const inventory = require("../../services/marketing/channels/campaignInventory.service");
const performance = require("../../services/marketing/channels/campaignPerformance.service");
const identity = require("../../services/marketing/channels/campaignIdentity");
const cursorModule = require("../../services/marketing/channels/campaignCursor");
const channelDates = require("../../services/marketing/channels/channelDates");
const secretsModule = require("../../services/marketing/channels/channelSecrets");
const googleAds = require("../../services/marketing/channels/googleAdsClient");
const analyticsClient = require("../../services/marketing/channels/googleAnalyticsClient");

const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };

/* ── THE FAKE PROVIDER ───────────────────────────────────────────────────────
   A queue of handlers matched on the request. Every call GRAV makes is recorded,
   so a test can assert the METHOD and the absence of a credential in a URL as
   easily as it asserts the response. */
let calls = [];
let handlers = [];

const onRequest = (match, respond) => handlers.push({ match, respond });

const reply = (status, data) => ({ status, data });

beforeEach(() => {
  calls = [];
  handlers = [];
  axios.mockImplementation(async (config) => {
    calls.push(config);
    for (const h of handlers) {
      if (h.match(config)) {
        const out = await h.respond(config);
        if (out instanceof Error) throw out;
        return out;
      }
    }
    /* An unmatched request is a test that did not say what the provider would
       do. Answered with a 500 rather than silently succeeding, so the omission
       surfaces as a failure rather than as a passing test. */
    return reply(500, { error: "no handler for this request in the test" });
  });
});

/* Always answered, because every Google call needs a token first. */
const withGoogleToken = () => onRequest(
  (c) => String(c.url).includes("oauth2.googleapis.com/token"),
  () => reply(200, { access_token: "fake-access-token", expires_in: 3600 }),
);

const transportError = (code) => Object.assign(new Error(code), { code });

/* ═══ ENVIRONMENT ═══════════════════════════════════════════════════════════

   Every suite that sets env restores it, because a scope variable leaking out of
   one jest worker made a later suite perform live HTTP and turned a 20-second
   run into a 49-minute one. */
const ENV_KEYS = [
  "MARKETING_COMPANY_ID", "MARKETING_CHANNEL_ID_SECRET", "MAUTIC_BASE_URL",
  "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "META_ADS_ACCESS_TOKEN", "META_ADS_ACCOUNT_ID", "META_ADS_APP_ID", "META_ADS_APP_SECRET",
  "GA4_PROPERTY_ID", "GA4_SERVICE_ACCOUNT_KEY", "GA4_CLIENT_ID", "GA4_CLIENT_SECRET", "GA4_REFRESH_TOKEN",
];
const savedEnv = {};

let app;
let server;
let base;
let A;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  app = express();
  /* The real router. The company is injected under the memo key the router
     reads, so a cross-company test can present a company the actor is not in
     without a membership fixture for every case. */
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/advertisingChannels"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  /* The adapters cache access tokens by credential fingerprint. Cleared so one
     test's token cannot let the next one skip its token exchange and pass
     against a handler it never declared. */
  googleAds.__test.tokenCache.clear();
  analyticsClient.__test.tokenCache.clear();
});

beforeEach(async () => {
  const c = await Acc_Company.create({ companyName: "GRAV Ads", booksFromDate: new Date("2026-04-01") });
  A = c._id;
  process.env.MARKETING_COMPANY_ID = String(A);
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const configureGoogleAds = () => {
  process.env.GOOGLE_ADS_CLIENT_ID = "gid";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "gsecret";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "grefresh";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "gdev";
  process.env.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
};

const configureMeta = () => {
  process.env.META_ADS_ACCESS_TOKEN = "meta-token-value";
  process.env.META_ADS_ACCOUNT_ID = "act_998877";
};

const configureGa4 = () => {
  process.env.GA4_PROPERTY_ID = "properties/44556";
  process.env.GA4_CLIENT_ID = "aid";
  process.env.GA4_CLIENT_SECRET = "asecret";
  process.env.GA4_REFRESH_TOKEN = "arefresh";
};

const call = async (path, { user = ADMIN, company = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
    },
  });
  return { status: res.status, body: await res.json() };
};

/* A campaign id minted the way the list route mints one. */
const idFor = (channel, providerId) =>
  identity.encodeCampaignId({ companyId: String(A), channel, providerCampaignId: providerId });

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE CHANNEL DIRECTORY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the channel directory reports connection, never campaign state", () => {
  test("all four channels unconfigured: not_configured, and nothing claims ready", async () => {
    const res = await call("/channels");
    expect(res.status).toBe(200);

    const byCode = Object.fromEntries(res.body.channels.map((c) => [c.channel, c]));
    expect(Object.keys(byCode).sort())
      .toEqual(["email", "google_ads", "google_analytics", "meta_ads"]);

    for (const code of ["google_ads", "meta_ads", "google_analytics", "email"]) {
      expect(byCode[code].state).toBe("not_configured");
      expect(byCode[code].configured).toBe(false);
      expect(byCode[code].available).toBe(false);
    }

    /* Nothing was asked of any provider. An unconfigured channel is answered
       from configuration, not by a request that would fail. */
    expect(calls).toHaveLength(0);
  });

  test("the channels are named, and the email engine is not", async () => {
    const res = await call("/channels");
    const byCode = Object.fromEntries(res.body.channels.map((c) => [c.channel, c]));

    /* Advertising channels ARE named: a marketer holds the account. */
    expect(byCode.google_ads.label).toBe("Google Ads");
    expect(byCode.meta_ads.label).toBe("Meta Ads");
    expect(byCode.google_analytics.label).toBe("Google Analytics");

    /* The engine behind email is not, anywhere in the payload — not in a label,
       a summary, a variable name or a diagnostic. */
    expect(byCode.email.label).toBe("Email");
    expect(JSON.stringify(res.body)).not.toMatch(/mautic/i);
  });

  test("the roles separate a publisher from a measurement source", async () => {
    const res = await call("/channels");
    const byCode = Object.fromEntries(res.body.channels.map((c) => [c.channel, c]));

    expect(byCode.google_ads.role).toBe("advertising");
    expect(byCode.meta_ads.role).toBe("advertising");
    /* GA4 measures. It publishes nothing, so it has no campaign list, and the
       capability says `unsupported` rather than `unknown` or `unavailable`. */
    expect(byCode.google_analytics.role).toBe("measurement");
    expect(byCode.google_analytics.capabilities.campaignRead).toBe("unsupported");
    expect(byCode.email.role).toBe("owned");
  });

  test("Google Ads ready on a real read, with capabilities confirmed separately", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => {
      if (String(c.data?.query).includes("FROM customer")) {
        return reply(200, {
          results: [{ customer: { id: "1234567890", descriptiveName: "GRAV Clothing", currencyCode: "INR", timeZone: "Asia/Kolkata" } }],
        });
      }
      return reply(200, { results: [] });
    });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(ga.configured).toBe(true);
    expect(ga.available).toBe(true);
    expect(ga.state).toBe("ready");
    expect(ga.capabilities.accountRead).toBe("confirmed");
    expect(ga.capabilities.campaignRead).toBe("confirmed");
    expect(ga.capabilities.reportingRead).toBe("confirmed");
    expect(ga.lastSuccessfulCheckAt).toBeTruthy();

    /* Google writes a customer id with hyphens and refuses one in a URL. */
    const search = calls.find((c) => String(c.url).includes("googleAds:search"));
    expect(search.url).toContain("/customers/1234567890/");
  });

  test("each provider is independent: Meta down does not blank Google Ads", async () => {
    configureGoogleAds();
    configureMeta();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1234567890", currencyCode: "INR" } }] })
        : reply(200, { results: [] })
    ));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => transportError("ETIMEDOUT"));

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");
    const meta = res.body.channels.find((c) => c.channel === "meta_ads");

    expect(ga.state).toBe("ready");
    expect(ga.available).toBe(true);
    /* And Meta's failure is its own, and is not a statement about campaigns. */
    expect(meta.state).toBe("unavailable");
    expect(meta.available).toBe(false);
    expect(meta.summary).toMatch(/campaigns are unaffected/i);
  });

  test("access refused is not temporary, and says somebody must act", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("graph.facebook.com"),
      () => reply(403, { error: { message: "Unsupported get request", code: 100 } }));

    const res = await call("/channels");
    const meta = res.body.channels.find((c) => c.channel === "meta_ads");

    expect(meta.state).toBe("access_refused");
    expect(meta.configured).toBe(true);
    expect(meta.available).toBe(false);
    expect(meta.capabilities.accountRead).toBe("refused");
    expect(meta.summary).toMatch(/review the connection/i);
    /* Meta's own message and code never travel. */
    expect(JSON.stringify(res.body)).not.toMatch(/Unsupported get request/);
  });

  test("probe=false answers from configuration and claims nothing", async () => {
    configureGoogleAds();
    const res = await call("/channels?probe=false");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(res.body.probed).toBe(false);
    expect(ga.configured).toBe(true);
    /* Configured is not connected, and `unknown` is the honest word for it. */
    expect(ga.state).toBe("unknown");
    expect(ga.available).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. SECRETS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no secret reaches a response, a log or a query string", () => {
  test("a response carries no credential value, only variable names for an admin", async () => {
    configureGoogleAds();
    configureMeta();
    configureGa4();
    process.env.GOOGLE_ADS_CUSTOMER_ID = "";

    const res = await call("/channels");
    const text = JSON.stringify(res.body);

    for (const value of ["gid", "gsecret", "grefresh", "gdev", "meta-token-value", "asecret", "arefresh"]) {
      expect(text).not.toContain(value);
    }

    /* A NAME is not a secret, and it is the one thing that makes this fixable.
       Published to an administrator only. */
    const ga = res.body.channels.find((c) => c.channel === "google_ads");
    expect(ga.diagnostics.missing).toContain("GOOGLE_ADS_CUSTOMER_ID");
  });

  test("an ordinary marketer gets business wording and no diagnostics at all", async () => {
    configureGoogleAds();
    /* A variable that is still REQUIRED. The developer token no longer is:
       Google sunset it on 2026-09-09, so blanking it leaves the channel
       configured (see the v25 contract suite). */
    process.env.GOOGLE_ADS_REFRESH_TOKEN = "";

    const res = await call("/channels", { user: MARKETER });
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(res.body.diagnosticsVisible).toBe(false);
    expect(ga).not.toHaveProperty("diagnostics");
    expect(ga).not.toHaveProperty("account");
    expect(ga.state).toBe("not_configured");
    expect(ga.summary).toMatch(/Not connected/i);
    /* Not one variable name, which is an implementation detail a marketer cannot
       act on and would only find alarming. */
    expect(JSON.stringify(res.body)).not.toMatch(/GOOGLE_ADS_/);
  });

  test("an admin diagnostic distinguishes the failure kinds without a secret", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(429, { error: { code: 17 } }));

    const res = await call("/channels");
    const meta = res.body.channels.find((c) => c.channel === "meta_ads");

    /* Quota is distinguishable from authentication, which is the point of the
       admin view. Both are `unavailable`/`access_refused` to a marketer. */
    expect(meta.diagnostics.failureCode).toBe("CHANNEL_RATE_LIMITED");
    expect(JSON.stringify(res.body)).not.toContain("meta-token-value");
  });

  test("the Meta token travels in a header, never in the query string", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("graph.facebook.com"),
      () => reply(200, { id: "act_998877", name: "GRAV", currency: "INR", timezone_name: "Asia/Kolkata" }));

    await call("/channels");

    const metaCalls = calls.filter((c) => String(c.url).includes("graph.facebook.com"));
    expect(metaCalls.length).toBeGreaterThan(0);
    for (const c of metaCalls) {
      /* Meta's own documentation puts it here. That would place a long-lived
         credential in every outbound request log and every error carrying a URL. */
      expect(String(c.url)).not.toContain("access_token");
      expect(JSON.stringify(c.params || {})).not.toContain("meta-token-value");
      expect(c.headers.Authorization).toBe("Bearer meta-token-value");
    }
  });

  test("the redaction helper blanks values and keeps shape", () => {
    const out = secretsModule.sanitise({
      GOOGLE_ADS_REFRESH_TOKEN: "grefresh",
      nested: { META_ADS_ACCESS_TOKEN: "meta-token-value", accountId: "998877" },
      customerId: "1234567890",
    });
    expect(out.GOOGLE_ADS_REFRESH_TOKEN).toBe("[redacted]");
    expect(out.nested.META_ADS_ACCESS_TOKEN).toBe("[redacted]");
    /* An account id is not a secret. Redacting everything would make a
       diagnostic useless and teach an operator to ignore it. */
    expect(out.nested.accountId).toBe("998877");
    expect(out.customerId).toBe("1234567890");
  });

  test("a logged failure names the operation and the path, and carries no credential", async () => {
    configureMeta();
    const logged = [];
    const spy = jest.spyOn(console, "error").mockImplementation((...args) => logged.push(args.join(" ")));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(401, { error: { message: "Invalid OAuth access token" } }));

    await call("/channels");
    spy.mockRestore();

    const line = logged.find((l) => l.includes("meta_ads"));
    /* The real detail an operator needs. */
    expect(line).toContain("account.verify");
    expect(line).toContain("graph.facebook.com");
    /* And not the credential, nor the query string that might carry one. */
    expect(logged.join("\n")).not.toContain("meta-token-value");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. CAMPAIGN INVENTORY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("campaign inventory is normalised without being flattened", () => {
  const googleCampaignRows = (rows, nextPageToken = null) => onRequest(
    (c) => String(c.url).includes("googleAds:search"),
    (c) => (String(c.data?.query).includes("FROM customer")
      ? reply(200, { results: [{ customer: { id: "1234567890", currencyCode: "INR" } }] })
      : reply(200, { results: rows, ...(nextPageToken ? { nextPageToken } : {}) })),
  );

  test("a Google Ads page normalises status, budget and currency", async () => {
    configureGoogleAds();
    withGoogleToken();
    googleCampaignRows([
      {
        campaign: {
          id: "20481", name: "Winter uniforms", status: "ENABLED",
          advertisingChannelType: "SEARCH", startDate: "2026-08-01", endDate: "2026-09-30",
        },
        campaignBudget: { amountMicros: "250000000" },
        customer: { currencyCode: "INR" },
      },
    ]);

    const res = await call("/campaigns?channel=google_ads");
    expect(res.status).toBe(200);
    expect(res.body.readState).toBe("ok");
    expect(res.body.rows).toHaveLength(1);

    const row = res.body.rows[0];
    expect(row.name).toBe("Winter uniforms");
    expect(row.channel).toBe("google_ads");
    expect(row.channelLabel).toBe("Google Ads");
    /* BOTH: GRAV's word for sorting, the provider's so a marketer's screen
       agrees with the dashboard they reconcile against. */
    expect(row.status).toBe("active");
    expect(row.providerStatus).toBe("ENABLED");
    expect(row.objective).toBe("SEARCH");

    /* 250000000 micros is 250.00 INR. The provider's own figure survives beside
       it, for reconciling against a Google invoice. */
    expect(row.dailyBudget).toMatchObject({
      amount: 250, currency: "INR", precision: "currency_units",
      providerAmount: "250000000", providerUnit: "micros",
    });
    /* No lifetime budget was sent. Null, not zero. */
    expect(row.lifetimeBudget).toBeNull();
  });

  test("an unrecognised provider status becomes unknown and keeps its own word", async () => {
    configureGoogleAds();
    withGoogleToken();
    googleCampaignRows([
      { campaign: { id: "1", name: "Odd", status: "REMOVED_BY_SYSTEM" }, customer: { currencyCode: "INR" } },
    ]);

    const res = await call("/campaigns?channel=google_ads");
    /* NOT bucketed as ended or removed by a substring match, which would read as
       a decision somebody made. */
    expect(res.body.rows[0].status).toBe("unknown");
    expect(res.body.rows[0].providerStatus).toBe("REMOVED_BY_SYSTEM");
  });

  test("Meta minor units convert by currency, and an unknown currency says so", () => {
    /* 100 minor units per rupee. */
    expect(inventory.money({ amount: "500000", currency: "INR", unit: "minor" }))
      .toMatchObject({ amount: 5000, currency: "INR", precision: "currency_units" });
    /* The yen has no subdivision. Dividing by 100 here would report ¥5,000 as ¥50. */
    expect(inventory.money({ amount: "5000", currency: "JPY", unit: "minor" }))
      .toMatchObject({ amount: 5000, currency: "JPY", precision: "currency_units" });
    /* Three decimals in the Gulf. */
    expect(inventory.money({ amount: "5000", currency: "KWD", unit: "minor" }))
      .toMatchObject({ amount: 5, currency: "KWD" });
    /* And a currency the table does not know is NOT assumed to be two-decimal.
       The figure is published in minor units and labelled as such. */
    expect(inventory.money({ amount: "5000", currency: "XYZ", unit: "minor" }))
      .toMatchObject({ amount: 5000, currency: "XYZ", precision: "minor_units" });
  });

  test("a real zero campaigns is an empty array, and only after a successful read", async () => {
    configureGoogleAds();
    withGoogleToken();
    googleCampaignRows([]);

    const res = await call("/campaigns?channel=google_ads");
    expect(res.body.readState).toBe("ok");
    expect(res.body.rows).toEqual([]);
    expect(res.body.campaignCount).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });

  test("an unavailable channel returns null rows, never an empty list", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        : transportError("ETIMEDOUT")
    ));

    const res = await call("/campaigns?channel=google_ads");
    expect(res.status).toBe(200);
    expect(res.body.readState).toBe("unavailable");
    /* The distinction this whole contract exists for. An empty array here would
       render as "you have no campaigns" while the campaigns ran and spent. */
    expect(res.body.rows).toBeNull();
    expect(res.body.campaignCount).toBeNull();
    expect(res.body.providerTotal).toBeNull();
  });

  test("access refused on a list is refused, not empty", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("/campaigns"), () => reply(403, { error: {} }));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, { id: "act_998877" }));

    const res = await call("/campaigns?channel=meta_ads");
    expect(res.body.readState).toBe("access_refused");
    expect(res.body.rows).toBeNull();
  });

  test("a malformed provider envelope is malformed, not empty", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        /* `results` as a string rather than an array: a provider API change. */
        : reply(200, { results: "nope" })
    ));

    const res = await call("/campaigns?channel=google_ads");
    expect(res.body.readState).toBe("unavailable");
    expect(res.body.reasonCode).toBe("CHANNEL_MALFORMED_RESPONSE");
    expect(res.body.rows).toBeNull();
  });

  test("Meta: an EXPLICIT empty array is empty; an absent `data` is malformed", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("act_998877/campaigns"), () => reply(200, { data: [] }));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, { id: "act_998877" }));

    /* Meta always sends `data` on a successful collection read, as `[]` when
       empty. That is a proved empty result. */
    const explicit = await call("/campaigns?channel=meta_ads");
    expect(explicit.body.readState).toBe("ok");
    expect(explicit.body.rows).toEqual([]);

    /* A 200 WITHOUT it is a body GRAV does not recognise. It used to become an
       empty list by a permissive default, which rendered a permission problem as
       "you have no campaigns". */
    handlers = [];
    onRequest((c) => String(c.url).includes("act_998877/campaigns"), () => reply(200, {}));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, { id: "act_998877" }));
    const absent = await call("/campaigns?channel=meta_ads");
    expect(absent.body.readState).toBe("unavailable");
    expect(absent.body.reasonCode).toBe("CHANNEL_MALFORMED_RESPONSE");
    expect(absent.body.rows).toBeNull();
  });

  test("Google Ads: an omitted empty repeated field IS empty", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        /* proto3 JSON drops an empty repeated field, so a page that matched
           nothing arrives with no `results` key at all. Refusing that would make
           "this account has no campaigns" an error. */
        : reply(200, {})
    ));

    const res = await call("/campaigns?channel=google_ads");
    expect(res.body.readState).toBe("ok");
    expect(res.body.rows).toEqual([]);
  });

  test("a provider error envelope delivered with HTTP 200 is not an empty list", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("act_998877/campaigns"),
      /* Meta answers some failures with a 200 and an `error` object. Without a
         check for it, the body has no `data`, and the status mapping never sees
         an error status to map. */
      () => reply(200, { error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" } }));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, { id: "act_998877" }));

    const res = await call("/campaigns?channel=meta_ads");
    expect(res.body.rows).toBeNull();
    /* And classified by the envelope's own code, so a permission failure
       delivered with a 200 still reads as refused rather than as an outage. */
    expect(res.body.readState).toBe("access_refused");
    expect(JSON.stringify(res.body)).not.toMatch(/Invalid OAuth/);
  });

  test("a cursor pages, belongs to its channel, and is opaque", async () => {
    configureGoogleAds();
    withGoogleToken();
    /* ── v25: GRAV PAGES BY campaign.id ───────────────────────────────────
       Google refuses a page size, so a page of one is `LIMIT 2`; the second
       row's presence is what says there is more. */
    googleCampaignRows([
      { campaign: { id: "1", name: "A", status: "ENABLED" }, customer: { currencyCode: "INR" } },
      { campaign: { id: "2", name: "B", status: "ENABLED" }, customer: { currencyCode: "INR" } },
    ]);

    const first = await call("/campaigns?channel=google_ads&limit=1");
    expect(first.body.rows.map((r) => r.name)).toEqual(["A"]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTruthy();
    const firstCall = calls.filter((c) => String(c.data?.query || "").includes("FROM campaign")).pop();
    expect(firstCall.data.query).toMatch(/ORDER BY campaign\.id ASC LIMIT 2$/);
    expect(firstCall.data).not.toHaveProperty("pageSize");
    expect(firstCall.data).not.toHaveProperty("pageToken");

    /* Carried back, it continues after the last id — never re-reading it. */
    handlers = [];
    withGoogleToken();
    googleCampaignRows([
      { campaign: { id: "2", name: "B", status: "ENABLED" }, customer: { currencyCode: "INR" } },
    ]);
    const second = await call(`/campaigns?channel=google_ads&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.rows[0].name).toBe("B");
    expect(second.body.hasMore).toBe(false);
    const listCall = calls.filter((c) => String(c.data?.query || "").includes("FROM campaign")).pop();
    expect(listCall.data.query).toContain("campaign.id > 1 ");
    expect(listCall.data).not.toHaveProperty("pageToken");

    /* And a cursor from Google cannot page Meta's list. One message for every
       cause, so a caller probing cursors learns nothing about which field it
       got wrong. */
    const crossed = await call(`/campaigns?channel=meta_ads&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(crossed.status).toBe(400);
    expect(crossed.body.error.message).toBe("That is not a valid page cursor.");
  });

  test("an out-of-range limit is refused, not clamped", async () => {
    configureGoogleAds();
    for (const limit of ["0", "101", "twenty", "-5"]) {
      const res = await call(`/campaigns?channel=google_ads&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(res.body.error.details.max).toBe(100);
    }
    /* A caller that asked for 500 and silently got 100 pages by an offset it
       believes it chose, and skips four hundred rows in silence. */
    expect(calls).toHaveLength(0);
  });

  test("a channel is required, and a measurement source has no campaign list", async () => {
    const none = await call("/campaigns");
    expect(none.status).toBe(400);
    expect(none.body.error.message).toMatch(/one channel at a time/i);

    configureGa4();
    const ga4 = await call("/campaigns?channel=google_analytics");
    expect(ga4.status).toBe(422);
    /* And the refusal explains the distinction rather than reporting an empty
       inventory built from whatever campaign names a browser happened to send. */
    expect(ga4.body.error.message).toMatch(/measures activity/i);
    expect(calls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. OPAQUE CAMPAIGN IDENTITY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the public campaign identifier is opaque and company-bound", () => {
  test("it carries no provider id in plain sight and no provider id is published", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        : reply(200, {
          results: [{ campaign: { id: "20481", name: "Winter", status: "ENABLED" }, customer: { currencyCode: "INR" } }],
        })
    ));

    const res = await call("/campaigns?channel=google_ads");
    const row = res.body.rows[0];

    expect(row.campaignId).toBeTruthy();
    /* The provider's id is not a field, under any name. */
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("providerCampaignId");
    /* And the signed token resolves only inside GRAV. */
    expect(identity.decodeCampaignId(row.campaignId, { companyId: String(A) }))
      .toMatchObject({ channel: "google_ads", providerCampaignId: "20481" });
  });

  test("a forged, malformed or foreign identifier is refused with no upstream call", async () => {
    configureGoogleAds();
    const real = idFor("google_ads", "20481");

    const forged = [
      "not-a-token",
      `${real}x`,
      /* Same payload, signed for another company. */
      identity.encodeCampaignId({
        companyId: new mongoose.Types.ObjectId().toString(),
        channel: "google_ads", providerCampaignId: "20481",
      }),
      Buffer.from("c1.someoneelse.google_ads.20481", "utf8").toString("base64url") + ".AAAAAAAAAAAAAAAAAAAAAA",
    ];

    for (const id of forged) {
      const res = await call(`/campaigns/${encodeURIComponent(id)}/performance?startDate=2026-09-01&endDate=2026-09-07`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CAMPAIGN_NOT_FOUND");
    }

    /* The requirement, and the reason: verification is local arithmetic, so this
       route cannot be used to make GRAV hammer a provider. */
    expect(calls).toHaveLength(0);
  });

  test("every refusal is the same refusal", async () => {
    const messages = new Set();
    for (const id of ["garbage", idFor("meta_ads", "1").slice(0, -3), "a.b"]) {
      const res = await call(`/campaigns/${encodeURIComponent(id)}/performance?startDate=2026-09-01&endDate=2026-09-02`);
      messages.add(res.body.error.message);
    }
    /* Distinguishing them would confirm to somebody probing identifiers that a
       given company and channel pair exists. */
    expect(messages.size).toBe(1);
  });

  test("without the signing secret, identifiers cannot be issued and the refusal names the variable", async () => {
    delete process.env.MARKETING_CHANNEL_ID_SECRET;
    expect(() => idFor("google_ads", "1")).toThrow(/cannot be issued/i);
    try {
      idFor("google_ads", "1");
    } catch (err) {
      expect(err.code).toBe("CHANNEL_IDENTITY_NOT_CONFIGURED");
      expect(err.details.missing).toEqual(["MARKETING_CHANNEL_ID_SECRET"]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. PERFORMANCE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("performance keeps zero, unavailable and unsupported apart", () => {
  test("a Google Ads read labels every metric and preserves currency", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), () => reply(200, {
      results: [{
        campaign: { id: "20481" },
        metrics: { costMicros: "12500000", impressions: "4210", clicks: "137", conversions: 6 },
        customer: { currencyCode: "INR" },
      }],
    }));

    const res = await call(`/campaigns/${idFor("google_ads", "20481")}/performance?startDate=2026-09-01&endDate=2026-09-07`);
    expect(res.status).toBe(200);
    expect(res.body.readState).toBe("ok");

    const m = res.body.metrics;
    expect(m.spend).toMatchObject({ value: 12.5, currency: "INR", state: "measured", source: "provider_reported", providerAmount: "12500000" });
    expect(m.impressions).toMatchObject({ value: 4210, state: "measured" });
    expect(m.clicks).toMatchObject({ value: 137, state: "measured" });

    /* Google Ads has no reach. Not zero: the concept does not exist there, and a
       zero would say Google measured nobody. */
    expect(m.reach).toMatchObject({ value: null, state: "unsupported" });
    /* A click is not a website visit — they differ by everybody who closed the
       tab. GA4 answers that one. */
    expect(m.websiteVisits).toMatchObject({ state: "unsupported", source: "analytics_reported" });

    /* A GRAV business outcome, which nothing in this chunk has earned. */
    expect(m.leads).toMatchObject({ value: null, state: "unavailable", source: "grav_owned" });
    expect(m.costPerLead.state).not.toBe("measured");

    /* Derived, and labelled as such. */
    expect(m.costPerClick).toMatchObject({ state: "measured", source: "grav_derived" });
    expect(m.costPerClick.value).toBeCloseTo(12.5 / 137, 10);

    expect(res.body.conversionBasis).toBe("provider_definition");
    expect(res.body.dateRange).toEqual({ startDate: "2026-09-01", endDate: "2026-09-07", days: 7 });
  });

  test("a measured zero stays zero, and an absent metric stays null", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), () => reply(200, {
      results: [{
        campaign: { id: "20481" },
        /* Clicks genuinely zero; conversions omitted by Google entirely. */
        metrics: { costMicros: "0", impressions: "900", clicks: 0 },
        customer: { currencyCode: "INR" },
      }],
    }));

    const res = await call(`/campaigns/${idFor("google_ads", "20481")}/performance?startDate=2026-09-01&endDate=2026-09-02`);
    const m = res.body.metrics;

    /* A real zero is a measurement. `Number(null)` is also 0, which is the bug
       this distinction exists to prevent. */
    expect(m.clicks).toMatchObject({ value: 0, state: "measured" });
    expect(m.spend).toMatchObject({ value: 0, state: "measured", currency: "INR" });
    expect(m.providerConversions).toMatchObject({ value: null, state: "unavailable" });

    /* Cost per click with no clicks is undefined, not zero — publishing 0 would
       make this the most efficient campaign in the account. */
    expect(m.costPerClick).toMatchObject({ value: null, state: "unavailable", reason: "undefined_no_denominator" });
  });

  test("a failed read leaves every metric unavailable and says it is not zero", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), () => transportError("ECONNRESET"));

    const res = await call(`/campaigns/${idFor("google_ads", "20481")}/performance?startDate=2026-09-01&endDate=2026-09-02`);
    expect(res.status).toBe(200);
    expect(res.body.readState).toBe("unavailable");

    for (const key of ["spend", "impressions", "clicks", "providerConversions"]) {
      expect(res.body.metrics[key].state).toBe("unavailable");
      expect(res.body.metrics[key].value).toBeNull();
    }
    expect(res.body.metrics.spend.value).not.toBe(0);
    expect(res.body.notes.join(" ")).toMatch(/unknown, not zero/i);
    expect(res.body.notes.join(" ")).toMatch(/says nothing about whether the campaign is running/i);
  });

  test("Meta reach is measured where Google has none, and the conversion definition is published", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("/insights"), () => reply(200, {
      data: [{
        campaign_id: "77001", spend: "842.55", impressions: "51200", reach: "38110", clicks: "1204",
        account_currency: "INR",
        actions: [
          { action_type: "link_click", value: "1204" },
          { action_type: "lead", value: "22" },
          { action_type: "post_engagement", value: "4000" },
        ],
      }],
    }));

    const res = await call(`/campaigns/${idFor("meta_ads", "77001")}/performance?startDate=2026-09-01&endDate=2026-09-07`);
    const m = res.body.metrics;

    expect(m.reach).toMatchObject({ value: 38110, state: "measured" });
    expect(m.spend).toMatchObject({ value: 842.55, currency: "INR", state: "measured" });

    /* `actions` is every tracked action of every type. Summing it would give
       5226 and mean nothing; only the outcome-shaped types are counted. */
    expect(m.providerConversions).toMatchObject({ value: 22, state: "measured" });
    /* And the DEFINITION is published, so a reader who disagrees can see it. */
    expect(res.body.notes.join(" ")).toContain("lead");
    expect(res.body.notes.join(" ")).not.toContain("post_engagement");
  });

  test("Meta and Google conversions are never presented as equivalent", async () => {
    /* Each is published under its own basis, on its own channel. Nothing in the
       contract totals them, and the vocabulary says why. */
    expect(performance.vocabulary.conversionBasis.map((b) => b.code))
      .toEqual(["provider_definition", "analytics_definition", "grav_definition"]);
    expect(performance.vocabulary.notClaimed.join(" "))
      .toMatch(/never totalled across them/i);
    expect(performance.vocabulary.notClaimed.join(" "))
      .toMatch(/Revenue, opportunities and return on ad spend are not in this contract/i);
  });

  test("the date range is required, bounded and ordered", async () => {
    configureGoogleAds();
    const id = idFor("google_ads", "20481");

    const none = await call(`/campaigns/${id}/performance`);
    expect(none.status).toBe(400);
    /* A server-chosen window means two identical requests minutes apart can
       cover different days, and a figure written down yesterday cannot be
       reproduced. */
    expect(none.body.error.message).toMatch(/cannot be reproduced/i);

    const reversed = await call(`/campaigns/${id}/performance?startDate=2026-09-09&endDate=2026-09-01`);
    expect(reversed.status).toBe(400);

    const huge = await call(`/campaigns/${id}/performance?startDate=2026-01-01&endDate=2026-09-01`);
    expect(huge.status).toBe(400);
    expect(huge.body.error.details.max).toBe(90);

    const shaped = await call(`/campaigns/${id}/performance?startDate=01-09-2026&endDate=2026-09-02`);
    expect(shaped.status).toBe(400);

    expect(calls).toHaveLength(0);
  });

  test("GA4 figures are analytics-reported, with the property timezone", async () => {
    configureGa4();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(200, {
      displayName: "GRAV Site", timeZone: "Asia/Kolkata", currencyCode: "INR",
    }));
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, {
      dimensionHeaders: [{ name: "sessionCampaignName" }, { name: "sessionSource" }, { name: "sessionMedium" }],
      metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "conversions" }],
      rows: [{
        dimensionValues: [{ value: "winter-uniforms" }, { value: "google" }, { value: "cpc" }],
        metricValues: [{ value: "812" }, { value: "640" }, { value: "0" }],
      }],
      rowCount: 1,
    }));

    const res = await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    expect(res.status).toBe(200);
    expect(res.body.readState).toBe("ok");
    expect(res.body.reportingTimeZone).toBe("Asia/Kolkata");
    expect(res.body.conversionBasis).toBe("analytics_definition");

    const row = res.body.rows[0];
    expect(row.sessions).toMatchObject({ value: 812, state: "measured", source: "analytics_reported" });
    /* A measured zero. */
    expect(row.conversions).toMatchObject({ value: 0, state: "measured", source: "analytics_reported" });
    /* And the caveat is in the payload, not only in a comment. */
    expect(res.body.notes.join(" ")).toMatch(/not by the advertising channels/i);
  });

  test("GA4 only sends explicit dates, never a relative range", async () => {
    configureGa4();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(200, { timeZone: "Asia/Kolkata" }));
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, {
      dimensionHeaders: [], metricHeaders: [], rows: [],
    }));

    await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    const report = calls.find((c) => String(c.url).includes(":runReport"));
    expect(report.data.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-07" }]);
    /* `28daysAgo` resolves against the property's timezone at call time, so two
       identical requests can cover different days. */
    expect(JSON.stringify(report.data)).not.toMatch(/daysAgo|yesterday|today/);
  });

  test("a sampled GA4 report is labelled approximate", async () => {
    configureGa4();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(200, { timeZone: "Asia/Kolkata" }));
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, {
      dimensionHeaders: [{ name: "sessionCampaignName" }],
      metricHeaders: [{ name: "sessions" }],
      rows: [{ dimensionValues: [{ value: "x" }], metricValues: [{ value: "10" }] }],
      metadata: { samplingMetadatas: [{ samplesReadCount: "100" }] },
    }));

    const res = await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    expect(res.body.sampled).toBe(true);
    expect(res.body.notes.join(" ")).toMatch(/estimated these figures/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. TRANSPORT BEHAVIOUR
   ═══════════════════════════════════════════════════════════════════════════ */

describe("reads are bounded, retried safely and never mutate", () => {
  test("a transient fault is retried once; an authorisation refusal is not", async () => {
    configureGoogleAds();
    withGoogleToken();

    let listAttempts = 0;
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => {
      if (String(c.data?.query).includes("FROM customer")) return reply(200, { results: [{ customer: { id: "1" } }] });
      listAttempts += 1;
      return reply(503, {});
    });
    await call("/campaigns?channel=google_ads");
    /* One retry, not none and not five: a marketer is waiting for a screen. */
    expect(listAttempts).toBe(2);

    handlers = [];
    withGoogleToken();
    let refusals = 0;
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => {
      if (String(c.data?.query).includes("FROM customer")) return reply(200, { results: [{ customer: { id: "1" } }] });
      refusals += 1;
      return reply(403, {});
    });
    await call("/campaigns?channel=google_ads");
    /* A 403 retried is a 403 twice. */
    expect(refusals).toBe(1);
  });

  test("a rate limit is not retried and is reported as its own state", async () => {
    configureMeta();
    let attempts = 0;
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => {
      attempts += 1;
      return reply(429, {});
    });

    const res = await call("/channels");
    /* Three capability probes, each asked once. Retrying a 429 immediately is
       how an account gets throttled harder, so no probe retries — and the count
       is three rather than one because the probes are INDEPENDENT, which is the
       point of the correction: reporting access is never inferred from account
       access. */
    expect(attempts).toBe(3);
    expect(res.body.channels.find((c) => c.channel === "meta_ads").diagnostics.failureCode)
      .toBe("CHANNEL_RATE_LIMITED");
  });

  test("every request is bounded and follows no redirect", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, { id: "act_998877" }));
    await call("/channels");

    for (const c of calls) {
      expect(c.timeout).toBeGreaterThan(0);
      expect(c.timeout).toBeLessThanOrEqual(15000);
      /* A 3xx from an API endpoint means GRAV is talking to something else, and
         following it would send the credential along. */
      expect(c.maxRedirects).toBe(0);
    }
  });

  test("no request GRAV makes can change anything in an advertising account", async () => {
    configureGoogleAds();
    configureMeta();
    configureGa4();
    withGoogleToken();
    onRequest(() => true, () => reply(200, {
      results: [{ customer: { id: "1" } }], data: [], id: "act_998877",
      dimensionHeaders: [], metricHeaders: [], rows: [],
    }));

    await call("/channels");
    await call("/campaigns?channel=google_ads");
    await call("/campaigns?channel=meta_ads");
    await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-02");

    expect(calls.length).toBeGreaterThan(4);
    for (const c of calls) {
      const verb = String(c.method).toUpperCase();
      expect(["GET", "POST"]).toContain(verb);
      /* Three POSTs are legitimate and all three READ: two OAuth exchanges and
         the two providers' report endpoints, which offer no GET equivalent. */
      if (verb === "POST") {
        expect(String(c.url)).toMatch(/oauth2\.googleapis\.com\/token|googleAds:search|:runReport/);
      }
    }
  });

  test("the read-only assertion refuses a write verb outright", () => {
    const http = require("../../services/marketing/channels/channelHttp");
    for (const method of ["PUT", "PATCH", "DELETE", "put"]) {
      expect(() => http.assertReadOnly({ method, operation: "x" }))
        .toThrow(/does not change anything/i);
    }
    /* And a POST without a stated read intent is refused too, so the next
       contributor cannot reach a mutation endpoint by reusing this core. */
    expect(() => http.assertReadOnly({ method: "POST", operation: "x" }))
      .toThrow(/does not change anything/i);
    expect(() => http.assertReadOnly({ method: "POST", readIntent: true, operation: "x" }))
      .not.toThrow();
  });

  test("no mutation route exists on the router", () => {
    const router = require("../../routes/CMS_Routes/Marketing/advertisingChannels");
    const verbs = new Set();
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const [verb, used] of Object.entries(layer.route.methods)) {
        if (used) verbs.add(verb.toUpperCase());
      }
    }
    expect([...verbs].sort()).toEqual(["GET"]);
  });

  test("nothing a caller supplies reaches a provider query", () => {
    /* GAQL has no parameter binding, so the defence is refusing a value that
       could change a query's meaning rather than escaping one. */
    expect(() => googleAds.__test.assertDigits("20481 OR 1=1", "campaignId")).toThrow();
    expect(() => googleAds.__test.assertDigits("'; SELECT", "campaignId")).toThrow();
    expect(() => googleAds.__test.assertDate("2026-09-01' OR '1", "startDate")).toThrow();
    expect(googleAds.__test.assertDigits("20481", "campaignId")).toBe("20481");
    /* And a status filter is a key in a closed map, never caller text. */
    expect(Object.keys(googleAds.__test.STATUS_FILTER).sort()).toEqual(["active", "paused", "removed"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. TENANCY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("one company never sees another's advertising", () => {
  test("a second company is refused everywhere, and nothing upstream is asked", async () => {
    configureGoogleAds();
    const other = new mongoose.Types.ObjectId();

    for (const path of [
      "/channels",
      "/campaigns?channel=google_ads",
      `/campaigns/${idFor("google_ads", "1")}/performance?startDate=2026-09-01&endDate=2026-09-02`,
      "/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-02",
    ]) {
      const res = await call(path, { company: other });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("MARKETING_COMPANY_NOT_CONFIGURED");
    }
    expect(calls).toHaveLength(0);
  });

  test("with no company configured at all, nothing is served", async () => {
    delete process.env.MARKETING_COMPANY_ID;
    const res = await call("/channels");
    expect(res.status).toBe(403);
    /* Serving every company the same advertising account is the failure this
       prevents, and it would have been a silent one. */
    expect(calls).toHaveLength(0);
  });

  test("account identifiers are an administrator's to see", async () => {
    configureMeta();
    const denied = await call("/channels/meta_ads/accounts", { user: MARKETER });
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);

    onRequest((c) => String(c.url).includes("/me/adaccounts"), () => reply(200, {
      data: [{ id: "act_998877", name: "GRAV Clothing", currency: "INR" }],
    }));
    const allowed = await call("/channels/meta_ads/accounts", { user: ADMIN });
    expect(allowed.status).toBe(200);
    expect(allowed.body.accounts[0]).toMatchObject({ accountId: "998877", accountName: "GRAV Clothing" });
  });

  test("an ordinary marketer can still read campaigns and performance", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        : reply(200, { results: [{ campaign: { id: "9", name: "Spring", status: "PAUSED" }, customer: { currencyCode: "INR" } }] })
    ));

    const res = await call("/campaigns?channel=google_ads", { user: MARKETER });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ name: "Spring", status: "paused" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. THE INTERNAL ENGINE STAYS INVISIBLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the internal campaign engine is never disclosed", () => {
  test("no advertising response names it, in any state", async () => {
    configureGoogleAds();
    configureMeta();
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    onRequest(() => true, () => transportError("ECONNREFUSED"));

    for (const path of [
      "/channels",
      "/channels?probe=false",
      "/campaigns?channel=google_ads",
      "/campaigns?channel=meta_ads",
      `/campaigns/${idFor("google_ads", "1")}/performance?startDate=2026-09-01&endDate=2026-09-02`,
      "/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-02",
    ]) {
      const res = await call(path);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/mautic/i);
      /* Nor its configuration variables, which would name it just as clearly. */
      expect(text).not.toMatch(/MAUTIC_/);
      expect(text).not.toMatch(/127\.0\.0\.1/);
    }
  });

  test("the email channel reports its state without naming what sends it", async () => {
    /* A closed port. The URL is present and the engine does not answer. */
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    const res = await call("/channels");
    const email = res.body.channels.find((c) => c.channel === "email");

    expect(email.label).toBe("Email");
    /* Configured, and NOT ready — the correction. */
    expect(email.configured).toBe(true);
    expect(email.available).toBe(false);
    expect(email.state).toBe("unknown");
    /* And no missing-variable list, because those names name the product. */
    expect(email.diagnostics).toBeNull();
    expect(JSON.stringify(email)).not.toMatch(/mautic|127\.0\.0\.1|MAUTIC_/i);
  });

  test("the advertising channels' own names ARE published", async () => {
    const res = await call("/channels");
    const text = JSON.stringify(res.body);
    /* The rule is not uniform, and this is the half that is easy to over-apply:
       hiding Google Ads would make every figure unverifiable against the invoice
       the marketer pays. */
    expect(text).toContain("Google Ads");
    expect(text).toContain("Meta Ads");
    expect(text).toContain("Google Analytics");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. THE VOCABULARY IS SERVED, NOT HARD-CODED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a client never has to hard-code a label or a state", () => {
  test("the channel vocabulary travels with the data", async () => {
    const res = await call("/channels");
    expect(res.body.vocabulary.channels.map((c) => c.code).sort())
      .toEqual(["email", "google_ads", "google_analytics", "meta_ads"]);
    expect(res.body.vocabulary.states.map((s) => s.code).sort())
      .toEqual(["access_refused", "not_configured", "partially_ready", "ready", "unavailable", "unknown"]);
    expect(res.body.vocabulary.capabilities.map((c) => c.code))
      .toEqual(["accountRead", "campaignRead", "reportingRead"]);
  });

  test("the metric vocabulary states the three absences and the four sources", async () => {
    configureGoogleAds();
    const res = await call(`/campaigns/${idFor("google_ads", "1")}/performance?startDate=2026-09-01&endDate=2026-09-02`);
    expect(res.body.vocabulary.metricStates.map((s) => s.code))
      .toEqual(["measured", "unavailable", "unsupported"]);
    expect(res.body.vocabulary.metricSources.map((s) => s.code))
      .toEqual(["provider_reported", "analytics_reported", "grav_derived", "grav_owned"]);
    expect(res.body.vocabulary.maxRangeDays).toBe(90);
  });

  test("the money vocabulary explains both precisions", () => {
    expect(inventory.vocabulary.money.precisionMeans).toMatch(/minor_units/);
    expect(inventory.vocabulary.money.providerAmountMeans).toMatch(/invoice/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. EVERY CAPABILITY IS PROVED BY ITS OWN READ
   ═══════════════════════════════════════════════════════════════════════════

   The correction this section exists for: reporting used to be marked confirmed
   whenever the campaign list succeeded, because both share a credential and an
   endpoint family. Sharing a credential is not sharing an authorisation. Google
   gates `metrics.*` behind an approved developer token that `campaign.*` does
   not need; Meta can refuse the insights edge while serving the campaigns edge.
   Each combination below is a real deployment state. */

describe("no capability is inferred from another", () => {
  /* A Google Ads responder that answers each of the three probes differently,
     so the matrix below is exercised through the real adapter. */
  const googleProbes = ({ account, campaigns, reporting }) => {
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => {
      const query = String(c.data?.query);
      if (query.includes("FROM customer")) return account();
      if (query.includes("metrics.impressions")) return reporting();
      return campaigns();
    });
  };

  const ok = (data) => () => reply(200, data);
  const refused = () => () => reply(403, {});
  const down = () => () => transportError("ETIMEDOUT");

  const CUSTOMER = { results: [{ customer: { id: "1", currencyCode: "INR", timeZone: "Asia/Kolkata" } }] };

  test("account reads, campaign list fails: each capability shows its own state", async () => {
    configureGoogleAds();
    googleProbes({ account: ok(CUSTOMER), campaigns: down(), reporting: ok({ results: [] }) });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(ga.capabilities.accountRead).toBe("confirmed");
    expect(ga.capabilities.campaignRead).toBe("unavailable");
    /* Reporting succeeded on its OWN read, and is not dragged down by the
       campaign failure any more than it used to be dragged up by its success. */
    expect(ga.capabilities.reportingRead).toBe("confirmed");
    expect(ga.state).toBe("partially_ready");
    expect(ga.available).toBe(false);
  });

  test("campaign list reads, reporting is refused: reporting is refused, not confirmed", async () => {
    configureGoogleAds();
    googleProbes({ account: ok(CUSTOMER), campaigns: ok({ results: [] }), reporting: refused() });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(ga.capabilities.accountRead).toBe("confirmed");
    expect(ga.capabilities.campaignRead).toBe("confirmed");
    /* The exact case the old code got wrong. A developer token approved for test
       accounts serves campaigns and refuses metrics, and the channel used to
       report `ready` with a performance screen that could never fill. */
    expect(ga.capabilities.reportingRead).toBe("refused");
    expect(ga.state).toBe("partially_ready");
    expect(ga.summary).toMatch(/performance reporting is unavailable/i);
    expect(ga.summary).toMatch(/campaigns are unaffected/i);
  });

  test("campaign and reporting reads succeed independently: ready", async () => {
    configureGoogleAds();
    googleProbes({ account: ok(CUSTOMER), campaigns: ok({ results: [] }), reporting: ok({ results: [] }) });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    expect(ga.capabilities).toEqual({
      accountRead: "confirmed", campaignRead: "confirmed", reportingRead: "confirmed",
    });
    expect(ga.state).toBe("ready");
    expect(ga.available).toBe(true);

    /* And the reporting probe was a REAL reporting query, not a reused campaign
       list — a metric selection over a dated window. */
    const reportingCall = calls.find((c) => String(c.data?.query || "").includes("metrics.impressions"));
    expect(reportingCall).toBeTruthy();
    expect(String(reportingCall.data.query)).toMatch(/segments\.date BETWEEN/);
  });

  test("a zero-row reporting probe is still a successful reporting read", async () => {
    configureGoogleAds();
    /* An account that spent nothing yesterday is not an account GRAV cannot
       report on. Treating an empty result as a failure would mark every quiet
       account as broken. */
    googleProbes({ account: ok(CUSTOMER), campaigns: ok({ results: [] }), reporting: ok({}) });

    const res = await call("/channels");
    expect(res.body.channels.find((c) => c.channel === "google_ads").capabilities.reportingRead)
      .toBe("confirmed");
  });

  test("an authorisation refusal on the account read is applied, not re-probed", async () => {
    configureGoogleAds();
    let probes = 0;
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), () => {
      probes += 1;
      return reply(403, {});
    });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    /* A refused credential refuses every read, so asking three times produces
       three identical errors and three identical log lines. */
    expect(probes).toBe(1);
    expect(ga.capabilities).toEqual({
      accountRead: "refused", campaignRead: "refused", reportingRead: "refused",
    });
    expect(ga.state).toBe("access_refused");
  });

  test("a transient account failure still lets the other probes run", async () => {
    configureGoogleAds();
    googleProbes({ account: down(), campaigns: ok({ results: [] }), reporting: ok({ results: [] }) });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");

    /* The account endpoint can be briefly unavailable while the campaign
       endpoint answers. Abandoning the remaining probes would report a channel
       as less capable than it is. */
    expect(ga.capabilities.accountRead).toBe("unavailable");
    expect(ga.capabilities.campaignRead).toBe("confirmed");
    expect(ga.capabilities.reportingRead).toBe("confirmed");
    expect(ga.state).toBe("partially_ready");
  });

  test("Meta insights are probed separately from the campaign edge", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("/insights"), () => reply(403, {}));
    onRequest((c) => String(c.url).includes("/campaigns"), () => reply(200, { data: [] }));
    onRequest((c) => String(c.url).includes("graph.facebook.com"),
      () => reply(200, { id: "act_998877", name: "GRAV", currency: "INR", timezone_name: "Asia/Kolkata" }));

    const res = await call("/channels");
    const meta = res.body.channels.find((c) => c.channel === "meta_ads");

    /* The normal state of a token issued before app review. */
    expect(meta.capabilities.accountRead).toBe("confirmed");
    expect(meta.capabilities.campaignRead).toBe("confirmed");
    expect(meta.capabilities.reportingRead).toBe("refused");
    expect(meta.state).toBe("partially_ready");
  });

  test("a partly connected channel names its broken capability to an admin, by code", async () => {
    configureGoogleAds();
    googleProbes({ account: ok(CUSTOMER), campaigns: ok({ results: [] }), reporting: refused() });

    const res = await call("/channels");
    const ga = res.body.channels.find((c) => c.channel === "google_ads");
    expect(ga.diagnostics.capabilityFailures).toEqual({ reportingRead: "CHANNEL_ACCESS_REFUSED" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. THE EMAIL CHANNEL IS CHECKED, NOT ASSUMED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("email availability is a real read", () => {
  const engineHealth = (healthy) => ({
    check: async () => ({
      healthy,
      /* The real service returns a report full of the product's name. Nothing
         from it may reach a response. */
      baseUrl: "http://mautic.internal:8088",
      checks: { reachability: { state: healthy ? "ok" : "failed", detail: "Mautic could not be reached." } },
    }),
  });

  const emailRow = async (health) => {
    const view = await directory.list({ companyId: A, clients: { engineHealth: health } });
    return view.channels.find((c) => c.channel === "email");
  };

  test("a configured URL whose health read fails is NOT ready", async () => {
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    const row = await emailRow(engineHealth(false));

    /* Configuration is not availability. This used to be `ready` because a URL
       was present, which told a marketer their email channel worked while every
       send failed. */
    expect(row.configured).toBe(true);
    expect(row.available).toBe(false);
    expect(row.state).toBe("unknown");
    expect(row.lastSuccessfulCheckAt).toBeNull();
  });

  test("a healthy engine reads as ready", async () => {
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    const row = await emailRow(engineHealth(true));

    expect(row.state).toBe("ready");
    expect(row.available).toBe(true);
    expect(row.lastSuccessfulCheckAt).toBeTruthy();
  });

  test("a health read that throws is unknown, and its message never travels", async () => {
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    const row = await emailRow({
      check: async () => { throw new Error("Mautic at http://mautic.internal:8088 refused GRAV's credentials"); },
    });

    expect(row.state).toBe("unknown");
    expect(JSON.stringify(row)).not.toMatch(/mautic/i);
  });

  test("no engine detail escapes even from a healthy report", async () => {
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    for (const healthy of [true, false]) {
      const row = await emailRow(engineHealth(healthy));
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/mautic/i);
      expect(text).not.toMatch(/MAUTIC_/);
      expect(text).not.toMatch(/8088|127\.0\.0\.1/);
    }
  });

  test("with no engine configured, nothing is read", async () => {
    delete process.env.MAUTIC_BASE_URL;
    let called = false;
    const row = await emailRow({ check: async () => { called = true; return { healthy: true }; } });

    expect(row.state).toBe("not_configured");
    expect(called).toBe(false);
  });

  test("probe=false leaves a configured engine unchecked, not ready", async () => {
    process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
    const view = await directory.list({ companyId: A, probe: false, clients: { engineHealth: engineHealth(true) } });
    const row = view.channels.find((c) => c.channel === "email");

    expect(row.configured).toBe(true);
    expect(row.state).toBe("unknown");
    expect(row.available).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. THE CURSOR IS SIGNED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a page cursor is integrity-protected, and refused locally", () => {
  const mint = (channel = "google_ads", pageToken = "provider-token-2", companyId = null) =>
    cursorModule.encodeCursor({ companyId: String(companyId || A), channel, pageToken });

  test("it is signed, and the raw provider token is never a response field", async () => {
    configureGoogleAds();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? reply(200, { results: [{ customer: { id: "1" } }] })
        : reply(200, {
          results: [
            { campaign: { id: "1", name: "A", status: "ENABLED" }, customer: { currencyCode: "INR" } },
            { campaign: { id: "2", name: "B", status: "ENABLED" }, customer: { currencyCode: "INR" } },
          ],
          nextPageToken: "google-page-2",
        })
    ));

    const res = await call("/campaigns?channel=google_ads&limit=1");
    /* The payload is decodable, which is fine — a page token is not
       confidential. What it must be is unforgeable. */
    expect(res.body.nextCursor).toBeTruthy();
    expect(res.body).not.toHaveProperty("nextPageToken");
    expect(res.body).not.toHaveProperty("pageToken");
    expect(JSON.stringify(res.body.rows)).not.toContain("google-page-2");
  });

  test("a modified cursor is refused, and reaches no provider", async () => {
    configureGoogleAds();
    const good = mint();
    const [body, signature] = [good.slice(0, good.lastIndexOf(".")), good.slice(good.lastIndexOf(".") + 1)];

    /* Rewrite the payload, keep the signature. This is exactly what base64 alone
       allowed: decode, edit the channel, re-encode. */
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    const swapped = Buffer.from(decoded.replace("google_ads", "meta_ads"), "utf8").toString("base64url");

    for (const bad of [
      `${swapped}.${signature}`,
      `${body}.${signature.slice(0, -2)}AA`,
      `${body}.`,
      "not-a-cursor",
      "a.b",
      Buffer.from("k1.x.google_ads.5.token", "utf8").toString("base64url") + ".AAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      const res = await call(`/campaigns?channel=google_ads&cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("That is not a valid page cursor.");
    }
    expect(calls).toHaveLength(0);
  });

  test("a cursor from another company is refused locally", async () => {
    configureGoogleAds();
    const other = new mongoose.Types.ObjectId();
    const foreign = mint("google_ads", "provider-token-2", other);

    const res = await call(`/campaigns?channel=google_ads&cursor=${encodeURIComponent(foreign)}`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a cursor from another channel is refused locally", async () => {
    configureMeta();
    const res = await call(`/campaigns?channel=meta_ads&cursor=${encodeURIComponent(mint("google_ads"))}`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("cursor and campaign-id signing purposes are separate", () => {
    /* One derived key for both would mean a bug in either verifier became a bug
       in both, and would let a value minted for one contract verify under the
       other. */
    const asCursor = cursorModule.encodeCursor({ companyId: String(A), channel: "google_ads", pageToken: "20481" });
    expect(() => identity.decodeCampaignId(asCursor, { companyId: String(A) })).toThrow();

    const asCampaign = idFor("google_ads", "20481");
    expect(() => cursorModule.decodeCursor(asCampaign, { companyId: String(A), channel: "google_ads" })).toThrow();
  });

  test("a provider token containing the delimiter round-trips", () => {
    /* Provider tokens are opaque strings that may contain any character,
       including whatever this format picked as a separator. The token's length
       is written first so parsing is positional and no character in it can be
       structural. */
    const awkward = "a.b.c.999.not-the-real-token";
    const cursor = cursorModule.encodeCursor({ companyId: String(A), channel: "meta_ads", pageToken: awkward });
    expect(cursorModule.decodeCursor(cursor, { companyId: String(A), channel: "meta_ads" })).toBe(awkward);
  });

  test("no cursor at all is the first page, not an error", () => {
    expect(cursorModule.decodeCursor("", { companyId: String(A), channel: "google_ads" })).toBeNull();
    expect(cursorModule.decodeCursor(null, { companyId: String(A), channel: "google_ads" })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. DATES ARE REAL CALENDAR DAYS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a date is checked against the calendar, not a pattern", () => {
  test("impossible days are refused before any provider call", async () => {
    configureGoogleAds();
    const id = idFor("google_ads", "20481");

    for (const bad of [
      "2026-02-31",  // February has no 31st
      "2026-04-31",  // nor April
      "2025-02-29",  // 2025 is not a leap year
      "2026-13-01",  // month 13
      "2026-00-10",  // month 0
      "2026-01-00",  // day 0
      "2026-01-32",
      "2026-1-01",   // not zero-padded
      "26-01-01",
    ]) {
      const res = await call(`/campaigns/${id}/performance?startDate=${bad}&endDate=2026-09-30`);
      expect(res.status).toBe(400);
    }
    /* Every one of these passes `/^\d{4}-\d{2}-\d{2}$/`, and several are
       silently normalised by a provider into a different month. */
    expect(calls).toHaveLength(0);
  });

  test("real leap days are accepted", () => {
    expect(channelDates.assertCalendarDate("2024-02-29", "d")).toBe("2024-02-29");
    expect(channelDates.assertCalendarDate("2000-02-29", "d")).toBe("2000-02-29");
    /* 1900 was not a leap year: divisible by 100 and not by 400. */
    expect(() => channelDates.assertCalendarDate("1900-02-29", "d")).toThrow();
  });

  test("the round trip is what catches a rollover", () => {
    /* `new Date("2026-02-31")` does not throw — it becomes 3 March. Parsing
       alone would accept it. */
    expect(Number.isNaN(new Date("2026-02-31").getTime())).toBe(false);
    expect(() => channelDates.assertCalendarDate("2026-02-31", "d")).toThrow(/does not exist/i);
  });

  test("a reversed range and an over-long range are both refused", async () => {
    configureGoogleAds();
    const id = idFor("google_ads", "20481");

    const reversed = await call(`/campaigns/${id}/performance?startDate=2026-09-09&endDate=2026-09-01`);
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.message).toMatch(/after the end date/i);

    const long = await call(`/campaigns/${id}/performance?startDate=2026-01-01&endDate=2026-09-01`);
    expect(long.status).toBe(400);
    expect(long.body.error.details.max).toBe(90);
    expect(calls).toHaveLength(0);
  });

  test("the same validator guards the inventory filters", async () => {
    configureGoogleAds();
    const res = await call("/campaigns?channel=google_ads&startDate=2026-02-31&endDate=2026-03-01");
    expect(res.status).toBe(400);
    /* A filter silently dropped is a list a caller believes is filtered and is
       not. */
    expect(calls).toHaveLength(0);
  });

  test("the same validator guards the analytics report", async () => {
    configureGa4();
    const res = await call("/analytics/campaign-performance?startDate=2025-02-29&endDate=2025-03-01");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a day count is exact across a month and a leap year", () => {
    expect(channelDates.assertDateRange({ startDate: "2026-01-01", endDate: "2026-01-31", maxDays: 90 }).days).toBe(31);
    expect(channelDates.assertDateRange({ startDate: "2024-02-01", endDate: "2024-03-01", maxDays: 90 }).days).toBe(30);
    expect(channelDates.assertDateRange({ startDate: "2026-09-01", endDate: "2026-09-01", maxDays: 90 }).days).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. THE TIMEZONE IS EVIDENCE, NOT PROSE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a reporting timezone is read or admitted", () => {
  const googleReport = (customer) => {
    withGoogleToken();
    onRequest((c) => String(c.url).includes("googleAds:search"), (c) => (
      String(c.data?.query).includes("FROM customer")
        ? customer()
        : reply(200, {
          results: [{
            campaign: { id: "20481" },
            metrics: { costMicros: "1000000", impressions: "10", clicks: "2" },
            customer: { currencyCode: "INR" },
          }],
        })
    ));
  };

  test("a known timezone is published and named in the note", async () => {
    configureGoogleAds();
    googleReport(() => reply(200, {
      results: [{ customer: { id: "1", currencyCode: "INR", timeZone: "Asia/Kolkata" } }],
    }));

    const res = await call(`/campaigns/${idFor("google_ads", "20481")}/performance?startDate=2026-09-01&endDate=2026-09-07`);
    expect(res.body.reportingTimeZone).toBe("Asia/Kolkata");
    expect(res.body.notes.join(" ")).toContain("Asia/Kolkata");
  });

  test("an unreadable timezone is null, and the note says so instead of claiming it", async () => {
    configureGoogleAds();
    /* The account read fails; the report still succeeds. */
    googleReport(() => reply(500, {}));

    const res = await call(`/campaigns/${idFor("google_ads", "20481")}/performance?startDate=2026-09-01&endDate=2026-09-07`);

    /* The figures are still there — a figure whose day boundaries are unknown is
       still worth showing. */
    expect(res.body.readState).toBe("ok");
    expect(res.body.metrics.impressions).toMatchObject({ value: 10, state: "measured" });

    /* And the prose matches the field. It used to say the figures were in the
       account's timezone while this was null. */
    expect(res.body.reportingTimeZone).toBeNull();
    const notes = res.body.notes.join(" ");
    expect(notes).toMatch(/could not read the account's reporting timezone/i);
    expect(notes).not.toMatch(/in the account's timezone/i);
  });

  test("Meta's timezone comes from the same account read", async () => {
    configureMeta();
    onRequest((c) => String(c.url).includes("/insights"), () => reply(200, {
      data: [{ campaign_id: "77001", spend: "10.00", impressions: "5", clicks: "1", account_currency: "INR" }],
    }));
    onRequest((c) => String(c.url).includes("graph.facebook.com"), () => reply(200, {
      id: "act_998877", currency: "INR", timezone_name: "America/New_York",
    }));

    const res = await call(`/campaigns/${idFor("meta_ads", "77001")}/performance?startDate=2026-09-01&endDate=2026-09-07`);
    expect(res.body.reportingTimeZone).toBe("America/New_York");
    expect(res.body.notes.join(" ")).toContain("America/New_York");
  });

  test("the GA4 report says when the property timezone is unknown", async () => {
    configureGa4();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(500, {}));
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, {
      dimensionHeaders: [{ name: "sessionCampaignName" }],
      metricHeaders: [{ name: "sessions" }],
      rows: [{ dimensionValues: [{ value: "x" }], metricValues: [{ value: "3" }] }],
    }));

    const res = await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    expect(res.body.readState).toBe("ok");
    expect(res.body.reportingTimeZone).toBeNull();
    expect(res.body.notes.join(" ")).toMatch(/could not read the property's reporting timezone/i);
  });

  test("GA4 mandatory headers absent is malformed, and absent rows are empty", async () => {
    configureGa4();
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(200, { timeZone: "Asia/Kolkata" }));

    /* Headers describe the report's shape. Reading positionally without them
       would map sessions onto conversions. */
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, { rows: [] }));
    const missing = await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    expect(missing.body.readState).toBe("unavailable");
    expect(missing.body.reasonCode).toBe("CHANNEL_MALFORMED_RESPONSE");
    expect(missing.body.rows).toBeNull();

    /* A report that matched nothing omits `rows`. That is genuinely empty. */
    handlers = [];
    withGoogleToken();
    onRequest((c) => String(c.url).includes("analyticsadmin"), () => reply(200, { timeZone: "Asia/Kolkata" }));
    onRequest((c) => String(c.url).includes(":runReport"), () => reply(200, {
      dimensionHeaders: [{ name: "sessionCampaignName" }],
      metricHeaders: [{ name: "sessions" }],
    }));
    const empty = await call("/analytics/campaign-performance?startDate=2026-09-01&endDate=2026-09-07");
    expect(empty.body.readState).toBe("ok");
    expect(empty.body.rows).toEqual([]);
  });
});
