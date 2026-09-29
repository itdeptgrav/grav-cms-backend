// test/marketing/google-search-deployment.test.js
//
// THE FIRST REAL ADVERTISING WRITE: BINDING, PREFLIGHT, AND PAUSED CREATION.
//
// ── NOTHING HERE TOUCHES AN ADVERTISING ACCOUNT ────────────────────────────
// Every provider call is an injected fake. The write client is exercised for
// real — its closed operation table, its status assertion, its URL building and
// its parent-field mapping all run — but its transport returns canned responses
// and its credential lookup is replaced. No network call is made by this suite,
// and there are no advertising credentials in this deployment to make one with.
//
// ── WHAT THE NUMBERED PROOFS ARE FOR ───────────────────────────────────────
// The characteristic failure of a first advertising write is not a crash. It is
// a campaign created in the wrong account, or twice, or one that quietly starts
// spending. Each numbered test below is one of those failures, written as the
// thing that must be impossible rather than as the feature that must work.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

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

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingCampaignDeployment,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
  MarketingCampaignDeploymentAttemptResult,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const Binding = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding");

const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const binding = require("../../services/marketing/deployment/accountBinding.service");
const mapper = require("../../services/marketing/deployment/googleSearchMapper");
const preflightService = require("../../services/marketing/deployment/googleSearchPreflight.service");
const creation = require("../../services/marketing/deployment/pausedCreation.service");
const bundleClient = require("../../services/marketing/channels/googleSearchBundle");
const marker = require("../../services/marketing/deployment/deploymentMarker");
const reconciler = require("../../services/marketing/deployment/bundleReconciliation.service");
const attempts = require("../../services/marketing/campaignDrafts/deploymentAttempt.service");
const targeting = require("../../services/marketing/deployment/targetingResolution.service");
const googleAdsClient = require("../../services/marketing/channels/googleAdsClient");
const { fail } = require("../../services/storePurchase/errors");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };

const ACCOUNT = "1234567890";
const MANAGER = "9876543210";

const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET"];
const savedEnv = {};
let app; let server; let base; let A;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDrafts"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDeployment"));
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

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  A = a._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const call = async (path, { user = ADMIN, method = "GET", body = null, company = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

/* ── READING A SOURCE FILE AS CODE, NOT AS PROSE ────────────────────────────
   Several proofs below are about what a file DOES NOT DO — no clock in the
   mapper, no delivering status in the write client. A plain read would match the
   comment that explains the rule, so comments are stripped first and the
   assertion is made against the code. */
const codeOf = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ═══════════════════════════════════════════════════════════════════════════
   THE FAKES
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── THE READ CLIENT ────────────────────────────────────────────────────────
   Answers exactly the five reads the deployment path makes. Every one can be
   made to throw, because "the account did not answer" is a different fact from
   "the account said no" and the code has to keep them apart. */
const GEO = Object.freeze({
  India: [{ criterionId: "2356", resourceName: "geoTargetConstants/2356", name: "India", canonicalName: "India", countryCode: "IN", targetType: "Country", status: "ENABLED" }],
  Maharashtra: [{ criterionId: "20993", resourceName: "geoTargetConstants/20993", name: "Maharashtra", canonicalName: "Maharashtra,India", countryCode: "IN", targetType: "State", status: "ENABLED" }],
  Mumbai: [{ criterionId: "1007785", resourceName: "geoTargetConstants/1007785", name: "Mumbai", canonicalName: "Mumbai,Maharashtra,India", countryCode: "IN", targetType: "City", status: "ENABLED" }],
  Goa: [{ criterionId: "20981", resourceName: "geoTargetConstants/20981", name: "Goa", canonicalName: "Goa,India", countryCode: "IN", targetType: "State", status: "ENABLED" }],
  /* Two real places with one name. Google answers with both, and taking the
     first would target Cambridgeshire when somebody meant Massachusetts. */
  Cambridge: [
    { criterionId: "1006886", resourceName: "geoTargetConstants/1006886", name: "Cambridge", canonicalName: "Cambridge,England,United Kingdom", countryCode: "GB", targetType: "City", status: "ENABLED" },
    { criterionId: "1018127", resourceName: "geoTargetConstants/1018127", name: "Cambridge", canonicalName: "Cambridge,Massachusetts,United States", countryCode: "US", targetType: "City", status: "ENABLED" },
  ],
});

const LANG = Object.freeze({
  en: [{ criterionId: "1000", resourceName: "languageConstants/1000", code: "en", name: "English", targetable: true }],
  hi: [{ criterionId: "1023", resourceName: "languageConstants/1023", code: "hi", name: "Hindi", targetable: true }],
  /* A code two constants answer to. Contrived, and the point is that GRAV asks
     rather than picks. */
  xx: [
    { criterionId: "1111", resourceName: "languageConstants/1111", code: "xx", name: "One", targetable: true },
    { criterionId: "2222", resourceName: "languageConstants/2222", code: "xx", name: "Two", targetable: true },
  ],
});

const fakeRead = (over = {}) => ({
  calls: [],
  findGeoTargets: jest.fn(async ({ name, targetTypes }) => (GEO[name] || [])
    /* The fake narrows by target type exactly as the query does, so a test that
       relies on the kind narrowing an ambiguity is testing the real behaviour. */
    .filter((c) => !targetTypes?.length || targetTypes.includes(c.targetType))),
  findLanguages: jest.fn(async ({ code }) => LANG[code] || []),
  readCampaignCriteria: jest.fn(async () => []),
  readBundleByMarker: jest.fn(async (args) => ({ marker: args.marker, labels: [], campaigns: [] })),
  accessibleAccounts: jest.fn(async () => [ACCOUNT]),
  /* ── IT ANSWERS ABOUT THE ACCOUNT IT WAS ASKED ABOUT ────────────────────
     Which is the behaviour the binding now insists on: a client that answered
     about its own default account would bind a company to whichever account the
     connection preferred, and `probeAccount` refuses that. */
  describeAccount: jest.fn(async ({ customerId }) => ({
    accountId: customerId || ACCOUNT,
    accountName: "GRAV Clothing Ads",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    isManager: false,
    isTestAccount: false,
    status: "ENABLED",
  })),
  findCampaignsByName: jest.fn(async () => []),
  hasConversionAction: jest.fn(async () => true),
  readDeliveryStates: jest.fn(async ({ campaignId }) => ([
    { role: "campaign", providerObjectId: campaignId, status: "PAUSED" },
  ])),
  ...over,
});

/* ── THE WRITE TRANSPORT ────────────────────────────────────────────────────
   Google's mutate shape: `{ results: [{ resourceName }] }`. It records every
   call so a test can assert the ORDER, the URL and the payload that would have
   gone out — which is where "nothing can enable delivery" is actually checked.

   `plan` maps an operation to what happens: an id, a thrown GRAV failure, or a
   lost response. */
/* ── THE FAKE CHANNEL, WHICH NOW ANSWERS ONE REQUEST ───────────────────────
   The whole bundle arrives as one `mutateOperations` array and comes back as one
   `mutateOperationResponses` array in the same order. `plan` lets a test make
   that one call refuse, or never answer — the only two failure modes an atomic
   protocol has. */
const RESULT_KEY = Object.freeze({
  labelOperation: "labelResult",
  campaignBudgetOperation: "campaignBudgetResult",
  campaignOperation: "campaignResult",
  campaignLabelOperation: "campaignLabelResult",
  adGroupOperation: "adGroupResult",
  adGroupAdOperation: "adGroupAdResult",
  adGroupCriterionOperation: "adGroupCriterionResult",
  campaignCriterionOperation: "campaignCriterionResult",
});

const RESOURCE_OF = Object.freeze({
  labelOperation: "labels",
  campaignBudgetOperation: "campaignBudgets",
  campaignOperation: "campaigns",
  campaignLabelOperation: "campaignLabels",
  adGroupOperation: "adGroups",
  adGroupAdOperation: "adGroupAds",
  adGroupCriterionOperation: "adGroupCriteria",
  campaignCriterionOperation: "campaignCriteria",
});

function fakeTransport(plan = {}) {
  let next = 1000;

  const t = async ({ operation, url, headers, data }) => {
    t.calls.push({ operation, url, headers, data });

    const step = plan[operation];
    if (typeof step === "function") return step({ operation, url, data });

    const account = url.match(/customers\/(\d+)\//)[1];

    if (data.validateOnly === true) {
      /* A validate-only mutate creates nothing and returns no results. */
      t.validated.push(data.mutateOperations.length);
      return { status: 200, data: {} };
    }

    const responses = data.mutateOperations.map((op) => {
      const key = Object.keys(op)[0];
      next += 1;
      const resourceName = `customers/${account}/${RESOURCE_OF[key]}/${next}`;
      t.created.push({ key, resourceName, providerObjectId: String(next), payload: op[key].create });
      return { [RESULT_KEY[key]]: { resourceName } };
    });

    return { status: 200, data: { mutateOperationResponses: responses } };
  };
  t.calls = [];
  t.created = [];
  t.validated = [];
  return t;
}

/* Everything the fake account holds, derived from what the transport recorded —
   so "what the channel holds" and "what GRAV sent" agree unless a test makes
   them disagree. `over` is how a test bends reality: flip an exclusion, drop a
   criterion, leave a campaign running, answer with two campaigns, or nothing. */
const accountFor = (transport, over = {}) => {
  const made = (key) => transport.created.filter((c) => c.key === key);

  const build = () => {
    const campaign = made("campaignOperation")[0];
    if (!campaign) return { marker: "", labels: [], campaigns: [] };

    const criteria = made("campaignCriterionOperation")
      .filter((c) => !(over.dropCriteria || []).includes(c.payload.location?.geoTargetConstant
        || c.payload.language?.languageConstant))
      .map((c) => ({
        criterionId: c.providerObjectId,
        type: c.payload.location ? "LOCATION" : "LANGUAGE",
        negative: (over.flipExclusions
          && c.payload.location
          && (over.flipExclusions === true || over.flipExclusions.includes(c.payload.location.geoTargetConstant)))
          ? !(c.payload.negative === true)
          : c.payload.negative === true,
        geoTargetConstant: c.payload.location?.geoTargetConstant || "",
        languageConstant: c.payload.language?.languageConstant || "",
      }));

    const one = {
      campaignId: campaign.providerObjectId,
      name: campaign.payload.name,
      status: over.campaignStatus || "PAUSED",
      channelType: "SEARCH",
      budgetResourceName: made("campaignBudgetOperation")[0]?.resourceName || "",
      labelResourceName: over.dropMarkerLink ? "" : made("labelOperation")[0]?.resourceName || "",
      budgets: made("campaignBudgetOperation").map((b) => ({
        budgetId: b.providerObjectId, name: b.payload.name,
        amountMicros: b.payload.amountMicros, period: b.payload.period, explicitlyShared: false,
      })),
      adGroups: made("adGroupOperation").map((g) => ({
        adGroupId: g.providerObjectId, name: g.payload.name,
        status: over.adGroupStatus || "PAUSED",
      })),
      ads: made("adGroupAdOperation").map((a) => ({
        adId: a.providerObjectId, status: over.adStatus || "PAUSED", finalUrls: a.payload.ad?.finalUrls || [],
      })),
      keywords: made("adGroupCriterionOperation")
        .filter((k) => !(over.dropKeywords || []).includes(k.payload.keyword?.text))
        .map((k) => ({
          criterionId: k.providerObjectId, status: over.keywordStatus || "PAUSED",
          text: k.payload.keyword?.text, matchType: k.payload.keyword?.matchType,
        })),
      criteria,
    };

    return {
      labels: [{ labelId: "L1", name: "marker", resourceName: made("labelOperation")[0]?.resourceName || "", status: "ENABLED" }],
      campaigns: over.duplicate ? [one, { ...one, campaignId: `${one.campaignId}-twin` }] : [one],
    };
  };

  return jest.fn(async ({ marker: asked }) => {
    if (over.unavailable) throw fail("CHANNEL_UNAVAILABLE", "no answer");
    if (over.empty) return { marker: asked, labels: [], campaigns: [] };
    return { marker: asked, ...build() };
  });
};

const authorise = async () => ({
  creds: { developerToken: "test-developer-token", loginCustomerId: "" },
  token: "test-access-token",
});

const deps = (over = {}) => {
  const transport = over.transport || fakeTransport();
  const googleAds = over.googleAds
    || fakeRead({ readBundleByMarker: accountFor(transport, over.account || {}) });
  return { ...over, googleAds, transport, authorise };
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES
   ═══════════════════════════════════════════════════════════════════════════ */

const GOOGLE_BRIEF = Object.freeze({
  channel: "google_ads",
  campaignType: "google_search",
  destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
  geoTargeting: [{ name: "India", kind: "country" }],
  geoExclusions: [{ name: "Goa", kind: "region" }],
  languages: ["en"],
  audiences: [],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "maximise_clicks" },
  /* Google v25 requires every new campaign to carry the advertiser's EU
     political-advertising declaration; GRAV never defaults it. */
  euPoliticalAdvertising: "does_not_contain",
  budgetRelationship: "campaign_daily",
  googleSearch: {
    headlines: ["Winter uniforms", "Hotel uniforms", "Bulk orders"],
    descriptions: ["Made to measure for hospitality.", "Delivered across India."],
    keywordThemes: ["hotel uniforms", "hospital uniforms"],
  },
  timezone: "Asia/Kolkata",
});

const PLAN = Object.freeze({
  name: "Winter uniforms",
  objective: "lead_generation",
  channels: ["google_ads"],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 2500,
  budgetCurrency: "INR",
  budgetBasis: "daily",
  conversionGoal: "form_submission",
});

const withoutKeys = (o) => {
  const out = { ...o };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
};

/** An approved plan with a complete Google Search brief. */
async function approvedPlan(briefOver = {}, planOver = {}) {
  const created = await drafts.create({
    companyId: A,
    user: MARKETER,
    payload: withoutKeys({
      ...PLAN,
      utmCampaign: fresh("winter"),
      idempotencyKey: fresh("k"),
      deploymentBriefs: [withoutKeys({ ...GOOGLE_BRIEF, ...briefOver })],
      ...planOver,
    }),
  });
  await drafts.submit({ companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision });
  await drafts.decide({
    companyId: A, user: ADMIN, campaignDraftId: created.campaignDraftId,
    decision: "approve", reason: "Approved for deployment.",
  });
  return drafts.loadForDeployment({ companyId: A, campaignDraftId: created.campaignDraftId });
}

/** A verified binding for company A. */
async function bindAccount(over = {}) {
  return binding.bind({
    companyId: A,
    channel: "google_ads",
    payload: { externalAccountId: ACCOUNT, ...over },
    actor: ADMIN,
  }, deps());
}

/* ── A PLAIN PLAN OBJECT, FOR THE PURE PROOFS ───────────────────────────────
   The mapper takes a plain object and touches no database, so most of its
   refusals are provable without a stored plan — and several of them HAVE to be,
   because the plan's own submission gate refuses an incomplete brief before it
   can ever be approved. That double defence is asserted in test 8; these
   fixtures are how the inner one is reached directly. */
const planObject = (over = {}, briefOver = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  draftRef: "MCP-2026-0001",
  name: "Winter uniforms",
  revision: 3,
  state: "approved",
  utmCampaign: "winter-uniforms",
  schedule: { startDate: "2026-10-01", endDate: "2026-12-15" },
  budget: { amount: 2500, currency: "INR", basis: "daily" },
  deploymentBriefs: [withoutKeys({ ...GOOGLE_BRIEF, ...briefOver })],
  ...over,
});

/* ── A RESOLUTION FOR THE PURE-MAPPER PROOFS ────────────────────────────────
   The mapper is pure and takes resolved targeting as an argument, so its own
   tests build one rather than calling a channel. */
const resolvedTargeting = (plan, over = {}) => ({
  resolvedFor: {
    campaignDraftId: String(plan._id),
    draftRef: plan.draftRef,
    approvedRevision: plan.revision,
    externalAccountId: ACCOUNT,
    bindingId: "",
    bindingRevision: 0,
  },
  locations: [{ requested: { name: "India", kind: "country" }, outcome: "resolved", criterionId: "2356", resourceName: "geoTargetConstants/2356", canonicalName: "India" }],
  exclusions: [{ requested: { name: "Goa", kind: "region" }, outcome: "resolved", criterionId: "20981", resourceName: "geoTargetConstants/20981", canonicalName: "Goa,India" }],
  languages: [{ requested: { tag: "en" }, outcome: "resolved", criterionId: "1000", resourceName: "languageConstants/1000", canonicalName: "English" }],
  complete: true,
  blockers: [],
  fingerprint: "fp-test",
  ...over,
});

/* ── THE PLANNED OBJECTS A REAL COMMAND CARRIES ─────────────────────────────
   Derived from the mapper, not hand-listed, because the command fingerprint is
   computed over them — including each criterion's resolved target and whether it
   is an exclusion. A hand-written list drifts the moment the mapping changes,
   and the test then proves nothing about the real command. */
const plannedFor = (plan) => mapper
  .map({
    plan,
    account: { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCOUNT },
    resolvedTargeting: liveTargeting(plan),
  })
  .mapping.objects.map((o) => ({
    role: o.role,
    ...(o.payload?.location?.geoTargetConstant
      ? { target: o.payload.location.geoTargetConstant, negative: o.negative === true }
      : {}),
    ...(o.payload?.language?.languageConstant
      ? { target: o.payload.language.languageConstant }
      : {}),
  }));

/* What the fake account actually resolves the default brief to. */
const liveTargeting = (plan) => ({
  resolvedFor: {
    campaignDraftId: String(plan._id),
    draftRef: plan.draftRef,
    approvedRevision: plan.revision,
    externalAccountId: ACCOUNT,
    bindingId: "",
    bindingRevision: 0,
  },
  locations: [{ requested: { name: "India", kind: "country" }, outcome: "resolved", criterionId: "2356", resourceName: "geoTargetConstants/2356", canonicalName: "India" }],
  exclusions: [{ requested: { name: "Goa", kind: "region" }, outcome: "resolved", criterionId: "20981", resourceName: "geoTargetConstants/20981", canonicalName: "Goa,India" }],
  languages: [{ requested: { tag: "en" }, outcome: "resolved", criterionId: "1000", resourceName: "languageConstants/1000", canonicalName: "English" }],
  complete: true, blockers: [], fingerprint: "fp",
});

/* The signed public identifier for a stored plan, which is what a route takes. */
const draftIdFor = (plan) => require("../../services/marketing/campaignDrafts/draftIdentity")
  .encodeDraftId({ companyId: String(A), draftId: String(plan._id) });

/* The identity a marker is derived from, for the tests that build one directly. */
const markerIdentity = (plan, over = {}) => ({
  companyId: String(A),
  /* A realistic identifier rather than a two-character stub: "b1" is valid hex
     and would appear inside a 32-character digest by chance roughly half the
     time, making the "carries no identifier" assertion below a coin toss. */
  bindingId: "507f1f77bcf86cd799439fee",
  externalAccountId: ACCOUNT,
  campaignDraftId: String(plan._id),
  approvedRevision: plan.revision,
  commandKey: "command-key",
  channel: "google_ads",
  campaignType: "google_search",
  ...over,
});

const createArgs = (plan, over = {}) => ({
  companyId: A,
  plan,
  idempotencyKey: fresh("deploy"),
  requestedBy: { id: ADMIN.id, name: ADMIN.name, role: "admin" },
  authorizedBy: { id: ADMIN.id, name: ADMIN.name, at: new Date() },
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1–3. THE ACCOUNT IS CHOSEN BY A PERSON, AND HOLDS NO CREDENTIAL
   ═══════════════════════════════════════════════════════════════════════════ */

describe("binding a company to an advertising account", () => {
  test("1. no credential can be stored on a binding, by name or by shape", async () => {
    /* ── BY NAME ──────────────────────────────────────────────────────────
       The allow-list is evaluated over the CALLER's keys, so an extra one is
       refused rather than dropped. A dropped key returns 200 and the sender
       believes the token was stored. */
    const byName = [
      "refreshToken", "developerToken", "clientSecret", "accessToken",
      "developer_token", "apiKey", "password", "bearerToken",
    ];
    for (const key of byName) {
      await expect(binding.bind({
        companyId: A, channel: "google_ads",
        payload: { externalAccountId: ACCOUNT, [key]: "1//0gX-secret-value-here" },
        actor: ADMIN,
      }, deps())).rejects.toMatchObject({ code: "VALIDATION" });
    }

    /* ── AND BY SHAPE, UNDER AN INNOCENT KEY ──────────────────────────────
       The same value pasted into `note`. A deny-list of names would store this
       one, and it would be in every backup for ever. */
    const secretValues = [
      "1//0gXlongrefreshtokenvaluegoeshere",
      "GOCSPX-abcdefghijklmnopqrstuvwx",
      "ya29.a0AfH6SMBabcdefghijklmnopqrstuv",
      "EAAJk2ZClongmetasystemusertokenvalue",
      "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ];
    for (const value of secretValues) {
      const err = await binding.bind({
        companyId: A, channel: "google_ads",
        payload: { externalAccountId: ACCOUNT, note: value },
        actor: ADMIN,
      }, deps()).catch((e) => e);
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toMatch(/looks like a credential/i);
    }

    expect(await Binding.countDocuments({})).toBe(0);

    /* ── AND THE MODEL IS THE LAST LINE ───────────────────────────────────
       Strict-throw, so anything that got past both checks is a write error
       rather than a silently dropped field. */
    await expect(Binding.create({
      companyId: A, channel: "google_ads", externalAccountId: ACCOUNT,
      boundBy: { id: new mongoose.Types.ObjectId(), name: "Ada" },
      refreshToken: "1//0gsomething",
    })).rejects.toThrow(/refreshToken/);
  });

  test("2. a stored binding contains the account and its labels, and nothing else", async () => {
    const { binding: view } = await bindAccount({ loginAccountId: MANAGER, note: "Main account" });

    expect(view.externalAccountId).toBe(ACCOUNT);
    expect(view.state).toBe("verified");
    expect(view.mayDeploy).toBe(true);
    /* Read from the account, not supplied: a currency somebody typed is a claim,
       and the budget check has to be against what the account bills in. */
    expect(view.currency).toBe("INR");
    expect(view.timeZone).toBe("Asia/Kolkata");

    const raw = await Binding.findOne({}).lean();
    const allowed = new Set([
      "_id", "__v", "companyId", "channel", "externalAccountId", "externalAccountName",
      "loginAccountId", "businessId", "accountStatus", "accountCapabilities",
      "currency", "timeZone", "note", "state", "boundBy", "revokedBy",
      "revokedReason", "lastVerification", "revision", "createdAt", "updatedAt",
    ]);
    for (const key of Object.keys(raw)) expect(allowed.has(key)).toBe(true);

    /* Nothing anywhere in the document reads like a credential. */
    const flat = JSON.stringify(raw);
    expect(flat).not.toMatch(/1\/\/0g|GOCSPX|ya29\.|developer.?token/i);
  });

  test("3. an outage is not a wrong account, and neither is a refusal an outage", async () => {
    /* A provider that did not answer has not said the account is wrong. Marking
       it wrong would send somebody to rebind a correct binding. */
    const unavailable = fakeRead({
      describeAccount: jest.fn(async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); }),
    });
    const out = await binding.bind({
      companyId: A, channel: "google_ads",
      payload: { externalAccountId: ACCOUNT }, actor: ADMIN,
    }, { googleAds: unavailable });

    expect(out.binding.state).toBe("unverified");
    expect(out.binding.mayDeploy).toBe(false);
    expect(out.binding.lastVerification.outcome).toBe("unreachable");

    /* A refusal IS a statement about the account. */
    await Binding.deleteMany({});
    const refused = fakeRead({
      describeAccount: jest.fn(async () => { throw fail("CHANNEL_ACCESS_REFUSED", "no"); }),
    });
    const out2 = await binding.bind({
      companyId: A, channel: "google_ads",
      payload: { externalAccountId: ACCOUNT }, actor: ADMIN,
    }, { googleAds: refused });
    expect(out2.binding.state).toBe("unreachable");
    expect(out2.binding.lastVerification.outcome).toBe("not_listed");

    /* Neither may be created in. */
    await expect(binding.forDeployment({ companyId: A, channel: "google_ads" }))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
  });

  test("4. the account is never inferred from the configured credentials", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       One OAuth identity commonly reaches several accounts. Taking the target
       from an environment variable means the first real campaign lands in
       whichever one a deployment variable happened to name. */
    process.env.GOOGLE_ADS_CUSTOMER_ID = "5555555555";
    try {
      await expect(binding.forDeployment({ companyId: A, channel: "google_ads" }))
        .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });

      const err = await binding.forDeployment({ companyId: A, channel: "google_ads" }).catch((e) => e);
      expect(err.message).toMatch(/somebody has to choose which account/i);

      /* And no line in the deployment services reads that variable. */
      const files = [
        "services/marketing/deployment/accountBinding.service.js",
        "services/marketing/deployment/pausedCreation.service.js",
        "services/marketing/deployment/googleSearchPreflight.service.js",
        "services/marketing/deployment/googleSearchMapper.js",
      ];
      for (const f of files) expect(codeOf(f)).not.toMatch(/GOOGLE_ADS_CUSTOMER_ID/);

      /* A binding names the account, and that is the one used. */
      await bindAccount();
      const bound = await binding.forDeployment({ companyId: A, channel: "google_ads" });
      expect(bound.externalAccountId).toBe(ACCOUNT);
      expect(bound.externalAccountId).not.toBe("5555555555");
    } finally {
      delete process.env.GOOGLE_ADS_CUSTOMER_ID;
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5–8. THE MAPPER: PURE, DETERMINISTIC, AND IT REFUSES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("mapping an approved plan to Google Search objects", () => {
  const account = { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCOUNT };

  test("5. the same plan and account always produce the same objects", async () => {
    const plan = await approvedPlan();

    const a = mapper.map({ plan, account, resolvedTargeting: resolvedTargeting(plan) });
    const b = mapper.map({ plan, account, resolvedTargeting: resolvedTargeting(plan) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    /* ── AND IT READS NO CLOCK, NO RANDOM AND NO ENVIRONMENT ──────────────
       A mapper that reached for one of these would make every retry a different
       command, and the idempotency the whole deployment record rests on would
       stop working without anything failing. */
    const src = codeOf("services/marketing/deployment/googleSearchMapper.js");
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(|Math\.random|process\.env|require\(.*(model|Model|service)/);
  });

  test("6. objects are produced in dependency order, with the statuses Google is given", async () => {
    const plan = await approvedPlan();
    const { mappable, mapping } = mapper.map({ plan, account, resolvedTargeting: resolvedTargeting(plan) });
    expect(mappable).toBe(true);

    expect(mapping.objects.map((o) => o.role)).toEqual([
      "budget", "campaign", "audience_group", "advertisement",
      "targeting_term", "targeting_term",
      /* Targeting last, because a campaign criterion needs the campaign. */
      "location_target", "location_target", "language_target",
    ]);

    /* ── EVERY DELIVERY-CAPABLE OBJECT IS STOPPED ─────────────────────────
       Including the nested ones. A check on the outermost payload only would
       miss the ad's status and the keyword's. */
    const statuses = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return undefined;
      for (const [k, val] of Object.entries(v)) {
        if (k === "status") statuses.push(val);
        walk(val);
      }
      return undefined;
    };
    walk(mapping.objects);
    expect(statuses.length).toBe(5);
    expect(new Set(statuses)).toEqual(new Set(["PAUSED"]));

    /* The budget has no status at all, rather than a false one. */
    expect(mapping.objects[0].payload).not.toHaveProperty("status");

    /* Search results only. Google's default would also spend this budget on the
       Display network and on search partners, which is a different product. */
    expect(mapping.objects[1].payload.networkSettings).toEqual({
      targetGoogleSearch: true,
      targetSearchNetwork: false,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    });
  });

  test("7. text that Google will not accept is refused, never trimmed", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       "Winter uniforms for the whole hospi" is money spent on a sentence that
       stops mid-word, approved by nobody, discovered weeks later. */
    const long = "Winter uniforms for the entire hospitality sector nationwide";
    expect(long.length).toBeGreaterThan(30);

    /* GRAV allows 120 characters in a headline, so this plan is perfectly
       approvable — the plan gate has no reason to stop it, and the mapper is the
       only thing between it and a truncated live ad. */
    const plan = await approvedPlan({
      googleSearch: { ...GOOGLE_BRIEF.googleSearch, headlines: [long, "Hotel uniforms", "Bulk orders"] },
    });
    const out = mapper.map({ plan, account, resolvedTargeting: resolvedTargeting(plan) });

    expect(out.mappable).toBe(false);
    expect(out.mapping).toBeNull();
    const p = out.problems.find((x) => x.code === "HEADLINE_TOO_LONG");
    expect(p).toBeTruthy();
    /* The actual length against the allowance, so the author knows how much to
       cut rather than guessing. */
    expect(p.length).toBe(long.length);
    expect(p.allowed).toBe(30);
    expect(p.field).toBe("googleSearch.headlines.0");

    /* Nowhere in the output does the truncated string appear. */
    expect(JSON.stringify(out)).not.toContain(long.slice(0, 30));

    /* Too few headlines is the same kind of refusal, and every problem is
       reported in ONE pass — an author told about one at a time edits six times. */
    const thin = planObject({}, {
      googleSearch: { headlines: [long], descriptions: ["Only one."], keywordThemes: [] },
    });
    const out2 = mapper.map({ plan: thin, account, resolvedTargeting: resolvedTargeting(thin) });
    expect(out2.problems.map((x) => x.code).sort()).toEqual(
      ["DESCRIPTION_COUNT", "HEADLINE_COUNT", "HEADLINE_TOO_LONG", "KEYWORD_COUNT"],
    );
  });

  test("8. an ambiguous or unsupported value is refused, not filled in from a provider default", async () => {
    /* ── EVERY ONE OF THESE HAS A GOOGLE DEFAULT ──────────────────────────
       And every one of those defaults decides how money is spent. */
    const cases = [
      [{ bidding: undefined }, "BIDDING_UNSUPPORTED"],
      [{ bidding: { strategy: "spend_it_all" } }, "BIDDING_UNSUPPORTED"],
      [{ bidding: { strategy: "target_cost_per_click" } }, "BIDDING_TARGET_MISSING"],
      /* Meta's budget model has no Google meaning. */
      [{ budgetRelationship: "ad_set_daily" }, "BUDGET_RELATIONSHIP_UNSUPPORTED"],
      [{ budgetRelationship: undefined }, "BUDGET_RELATIONSHIP_UNSUPPORTED"],
      [{ timezone: undefined }, "TIMEZONE_MISSING"],
      /* A landing page has no public address until the library publishes one,
         and guessing a path is a campaign that charges for 404s. */
      [{ destination: { kind: "grav_landing_page", contentId: "41" } }, "DESTINATION_UNRESOLVED"],
    ];

    for (const [briefOver, code] of cases) {
      const out = mapper.map({ plan: planObject({}, briefOver), account, resolvedTargeting: resolvedTargeting(planObject({}, briefOver)) });
      expect(out.mappable).toBe(false);
      expect(out.problems.map((p) => p.code)).toContain(code);
    }

    /* ── AND THE PLAN GATE ALREADY REFUSED MOST OF THEM ───────────────────
       Two independent defences, which is the point: the mapper is not the only
       thing standing between an ambiguous plan and a live campaign, and a plan
       carrying one of these cannot even reach approval. */
    await expect(approvedPlan({ bidding: undefined }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" });
  });

  test("9. a currency or timezone that disagrees with the account is refused, not converted", async () => {
    const plan = await approvedPlan();

    /* Google does not convert. A budget approved as 2,500 created in an account
       billing in another currency is 2,500 of THAT currency, and the number on
       the screen is the number that was approved. */
    const wrongCurrency = mapper.map({ plan, account: { ...account, currency: "USD" }, resolvedTargeting: resolvedTargeting(plan) });
    expect(wrongCurrency.mappable).toBe(false);
    expect(wrongCurrency.problems.map((p) => p.code)).toContain("CURRENCY_MISMATCH");

    /* Google runs a campaign on the ACCOUNT's days. Converting silently would
       make the stored plan and the live campaign disagree about when it starts. */
    const wrongTz = mapper.map({ plan, account: { ...account, timeZone: "America/New_York" }, resolvedTargeting: resolvedTargeting(plan) });
    expect(wrongTz.mappable).toBe(false);
    const tz = wrongTz.problems.find((p) => p.code === "TIMEZONE_MISMATCH");
    expect(tz.message).toMatch(/Asia\/Kolkata/);
    expect(tz.message).toMatch(/America\/New_York/);
  });

  test("10. targeting is applied, and the only remaining disclosure is one that widens nothing", async () => {
    const plan = await approvedPlan();
    const out = mapper.map({ plan, account, resolvedTargeting: resolvedTargeting(plan) });

    const codes = out.decisions.map((d) => d.code);
    expect(codes).toContain("KEYWORD_MATCH_TYPE");
    expect(codes).toContain("EVERYTHING_IS_CREATED_PAUSED");
    expect(codes).toContain("TARGETING_IS_APPLIED");

    /* ── THE DISCLOSURE THAT USED TO BE HERE IS GONE ──────────────────────
       `GEO_NOT_APPLIED` said a campaign had been created without the locations
       somebody chose. In Google that campaign runs EVERYWHERE the moment it is
       enabled, and the person enabling it is looking at a campaign that appears
       complete. It is a refusal now, not a note. */
    expect(codes).not.toContain("GEO_NOT_APPLIED");
    expect(codes).not.toContain("LANGUAGE_NOT_APPLIED");
    expect(JSON.stringify(out)).not.toMatch(/NOT applied/);

    /* Audiences stay a disclosure, and the reason is written down: unlike a
       missing location, a missing audience on a Search campaign narrows nothing
       and widens nothing — the search terms are the targeting. */
    const withAudience = planObject({}, { audiences: [{ name: "Hotel managers", kind: "interest" }] });
    const out2 = mapper.map({ plan: withAudience, account, resolvedTargeting: resolvedTargeting(withAudience) });
    const aud = out2.decisions.find((d) => d.code === "AUDIENCES_NOT_APPLIED");
    expect(aud.why).toMatch(/does not widen where the campaign runs/i);

    const url = new URL(out.mapping.summary.finalUrl);
    expect(url.searchParams.get("utm_campaign")).toBe(plan.utmCampaign);
    expect(url.searchParams.get("utm_source")).toBe("google");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11–13. PREFLIGHT READS, AND PROMISES NOTHING ABOUT ACTIVATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("preflight", () => {
  test("11. it performs no mutation and writes no attempt or deployment", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport();

    const out = await preflightService.preflight({ companyId: A, plan }, deps({ transport }));
    expect(out.creationReady).toBe(true);

    /* Not one write left the process... */
    expect(transport.calls).toHaveLength(0);
    /* ...and none was made in GRAV either. A preflight that wrote an intent
       would make `hasUnresolvedAttempt` block the real creation every time
       somebody opened a screen. */
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);

    /* Nor was the plan itself touched: its revision is what approval left it at. */
    const after = await drafts.loadForDeployment({
      companyId: A, campaignDraftId: require("../../services/marketing/campaignDrafts/draftIdentity")
        .encodeDraftId({ companyId: String(A), draftId: String(plan._id) }),
    });
    expect(after.revision).toBe(plan.revision);
    expect(after.deployed).toBe(false);
  });

  test("12. activationReady is false even when everything else passes", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const out = await preflightService.preflight({ companyId: A, plan }, deps());

    expect(out.creationReady).toBe(true);
    expect(out.activationReady).toBe(false);
    expect(out.activationBlocked.reasonCode).toBe("ACTIVATION_NOT_BUILT");
    expect(out.ifCreated).toMatchObject({ status: "PAUSED", spendsMoney: false, delivers: false });

    /* ── AND NO INPUT CAN MAKE IT TRUE ────────────────────────────────────
       It is read from a frozen constant; there is no expression in the service
       that evaluates to it. */
    const src = codeOf("services/marketing/deployment/googleSearchPreflight.service.js");
    expect(src).not.toMatch(/activationReady\s*[:=]\s*true/);
    expect(src).toMatch(/activationReady: ACTIVATION_NOT_IN_THIS_CHUNK\.activationReady/);
    /* And the constant it reads is frozen at false. */
    const { ACTIVATION_NOT_IN_THIS_CHUNK } = require("../../constants/marketingGoogleSearchDeployment");
    expect(ACTIVATION_NOT_IN_THIS_CHUNK.activationReady).toBe(false);
    expect(Object.isFrozen(ACTIVATION_NOT_IN_THIS_CHUNK)).toBe(true);
  });

  test("13. an account that cannot hold this campaign blocks creation, and says which fact did it", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    const cases = [
      [{ describeAccount: async () => ({ accountId: ACCOUNT, currency: "USD", timeZone: "Asia/Kolkata", isManager: false, status: "ENABLED" }) },
        "account_currency_matches"],
      [{ describeAccount: async () => ({ accountId: ACCOUNT, currency: "INR", timeZone: "Asia/Kolkata", isManager: true, status: "ENABLED" }) },
        "account_not_manager"],
      [{ describeAccount: async () => ({ accountId: ACCOUNT, currency: "INR", timeZone: "Asia/Kolkata", isManager: false, status: "SUSPENDED" }) },
        "account_usable"],
      /* A campaign of this name already exists. Either somebody made it by hand
         or an earlier attempt got further than its record says; both need a
         person, and a retry would make a duplicate. */
      [{ findCampaignsByName: async () => ([{ providerCampaignId: "77", name: "x", status: "PAUSED" }]) },
        "name_not_already_used"],
    ];

    for (const [over, code] of cases) {
      const out = await preflightService.preflight({ companyId: A, plan }, deps({ googleAds: fakeRead(over) }));
      expect(out.creationReady).toBe(false);
      const check = out.checks.find((c) => c.code === code);
      expect(check.status).toBe("failed");
      expect(out.creationBlockers.map((b) => b.code)).toContain(code);
    }

    /* A REMOVED campaign keeps its name and cannot deliver. Counting it would
       block every re-creation after a rollback, for ever. */
    const afterRollback = await preflightService.preflight({ companyId: A, plan }, deps({
      googleAds: fakeRead({ findCampaignsByName: async () => ([{ providerCampaignId: "77", name: "x", status: "REMOVED" }]) }),
    }));
    expect(afterRollback.checks.find((c) => c.code === "name_not_already_used").status).toBe("passed");

    /* An outage is `could_not_check`, not `failed`: GRAV has not been told the
       account is wrong, and it still refuses to create into it. */
    const outage = await preflightService.preflight({ companyId: A, plan }, deps({
      googleAds: fakeRead({ describeAccount: async () => { throw fail("CHANNEL_UNAVAILABLE", "x"); } }),
    }));
    expect(outage.creationReady).toBe(false);
    expect(outage.checks.find((c) => c.code === "account_reachable").status).toBe("could_not_check");
    /* Every dependent check is answered, not omitted — an absent check reads as
       a check that passed. */
    expect(outage.checks.filter((c) => c.status === "could_not_check").length).toBeGreaterThanOrEqual(5);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   14–17. CREATION: ORDERED, RECORDED BEFORE IT HAPPENS, AND STOPPED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("creating a paused campaign", () => {
  test("14. the whole campaign is one atomic request, in dependency order, every reference resolved inside it", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport();

    const out = await creation.createPaused(createArgs(plan), deps({ transport }));
    expect(out.created).toBe(true);
    expect(out.outcome).toBe("succeeded");

    /* ── ONE WRITE ────────────────────────────────────────────────────────
       Two calls: the validate-only pass, then the create. Both carry the SAME
       envelope, and only the second creates anything. There is no third, and
       there is no per-object call — the sequential protocol is gone. */
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].data.validateOnly).toBe(true);
    expect(transport.calls[1].data.validateOnly).toBeUndefined();
    expect(transport.calls[0].data.mutateOperations)
      .toEqual(transport.calls[1].data.mutateOperations);

    /* Every request goes to the one mutate endpoint of the BOUND account. */
    for (const c of transport.calls) {
      expect(c.url).toBe(`https://googleads.googleapis.com/v25/customers/${ACCOUNT}/googleAds:mutate`);
    }

    const ops = transport.calls[1].data.mutateOperations;

    /* ── THE EXACT SEQUENCE ───────────────────────────────────────────────
       Label first, because the campaign-label relationship refers to it.
       Targeting last, because a campaign criterion refers to the campaign. */
    expect(ops.map((o) => Object.keys(o)[0])).toEqual([
      "labelOperation",
      "campaignBudgetOperation",
      "campaignOperation",
      "campaignLabelOperation",
      "adGroupOperation",
      "adGroupAdOperation",
      "adGroupCriterionOperation", "adGroupCriterionOperation",
      "campaignCriterionOperation", "campaignCriterionOperation", "campaignCriterionOperation",
    ]);

    /* ── CREATE, AND ONLY CREATE ─────────────────────────────────────────── */
    for (const op of ops) {
      expect(Object.keys(Object.values(op)[0])).toEqual(["create"]);
    }

    /* ── ALL OR NOTHING, STATED ──────────────────────────────────────────── */
    expect(transport.calls[1].data.partialFailure).toBe(false);

    /* ── EVERY TEMPORARY NAME IS DEFINED BEFORE IT IS REFERENCED ──────────
       A forward reference is rejected by the channel with a field error naming
       an index, and the whole request creates nothing. */
    const defined = new Set();
    for (const op of ops) {
      const create = Object.values(op)[0].create;
      for (const [field, value] of Object.entries(create)) {
        if (field === "resourceName") continue;
        if (typeof value !== "string" || !value.startsWith(`customers/${ACCOUNT}/`)) continue;
        if (Number(value.split("/").pop()) >= 0) continue;
        expect(defined.has(value)).toBe(true);
      }
      if (create.resourceName) defined.add(create.resourceName);
    }

    /* ── AND EVERY TEMPORARY IDENTIFIER IS UNIQUE ACROSS RESOURCE TYPES ───
       Two operations sharing one makes the second silently overwrite the
       first's meaning. */
    const temps = ops.map((o) => Object.values(o)[0].create.resourceName).filter(Boolean);
    expect(new Set(temps).size).toBe(temps.length);
    const ids = temps.map((t) => Number(t.split("/").pop()));
    expect(ids.every((n) => Number.isInteger(n) && n < 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    /* The relationships themselves, by temporary name. */
    const by = (key) => ops.filter((o) => o[key]).map((o) => o[key].create);
    expect(by("campaignOperation")[0].campaignBudget).toBe(by("campaignBudgetOperation")[0].resourceName);
    expect(by("campaignLabelOperation")[0].campaign).toBe(by("campaignOperation")[0].resourceName);
    expect(by("campaignLabelOperation")[0].label).toBe(by("labelOperation")[0].resourceName);
    expect(by("adGroupOperation")[0].campaign).toBe(by("campaignOperation")[0].resourceName);
    expect(by("adGroupAdOperation")[0].adGroup).toBe(by("adGroupOperation")[0].resourceName);
    for (const kw of by("adGroupCriterionOperation")) {
      expect(kw.adGroup).toBe(by("adGroupOperation")[0].resourceName);
    }
    for (const c of by("campaignCriterionOperation")) {
      expect(c.campaign).toBe(by("campaignOperation")[0].resourceName);
    }

    /* Targeting carries the resolved identifiers, and the exclusion is explicit. */
    const criteria = by("campaignCriterionOperation");
    expect(criteria.filter((c) => c.location && c.negative === false)
      .map((c) => c.location.geoTargetConstant)).toEqual(["geoTargetConstants/2356"]);
    expect(criteria.filter((c) => c.location && c.negative === true)
      .map((c) => c.location.geoTargetConstant)).toEqual(["geoTargetConstants/20981"]);
    expect(criteria.find((c) => c.language).language.languageConstant).toBe("languageConstants/1000");
    for (const c of criteria) expect(c).not.toHaveProperty("status");
  });

  test("15. the marker and the intent are written before anything leaves the process", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    /* ── THE TWO-FACT PROTOCOL, OBSERVED AT THE MOMENT IT MATTERS ─────────
       At the instant the one write would leave the process, the intent row
       already exists AND already carries the marker. A process that dies here
       leaves behind both the knowledge that a request may have gone out and the
       string that can find what it made. */
    let stateAtWrite = null;
    const transport = fakeTransport({
      "googleSearchBundle.createPausedAtomic": async ({ url, data }) => {
        const intent = await MarketingCampaignDeploymentAttemptIntent.findOne({}).lean();
        const deployment = await MarketingCampaignDeployment.findOne({}).lean();
        stateAtWrite = {
          intents: await MarketingCampaignDeploymentAttemptIntent.countDocuments({}),
          intentMarker: intent?.deploymentMarker,
          deploymentMarker: deployment?.deploymentMarker,
        };
        const account = url.match(/customers\/(\d+)\//)[1];
        let n = 5000;
        return {
          status: 200,
          data: {
            mutateOperationResponses: data.mutateOperations.map((op) => {
              const key = Object.keys(op)[0];
              n += 1;
              return { [RESULT_KEY[key]]: { resourceName: `customers/${account}/${RESOURCE_OF[key]}/${n}` } };
            }),
          },
        };
      },
    });

    const key = fresh("deploy");
    await creation.createPaused(createArgs(plan, { idempotencyKey: key }), deps({ transport }));

    expect(stateAtWrite.intents).toBe(1);
    expect(marker.looksLikeMarker(stateAtWrite.intentMarker)).toBe(true);
    /* The same marker on both rows, because it is derived from the command
       rather than from an attempt. */
    expect(stateAtWrite.deploymentMarker).toBe(stateAtWrite.intentMarker);

    /* ── AND NOTHING IS CALLED AGAIN FOR A DEPLOYMENT THAT EXISTS ────────── */
    const second = fakeTransport();
    const again = await creation.createPaused(
      createArgs(plan, { idempotencyKey: key }), deps({ transport: second }),
    ).catch((e) => e);
    expect(again.code).toBe("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED");
    expect(second.calls).toHaveLength(0);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);

    /* And the attempt service refuses it independently, as `already_settled`. */
    const intent = await MarketingCampaignDeploymentAttemptIntent.findOne({}).lean();
    const settledAgain = await attempts.begin({
      companyId: A, deploymentId: intent.deploymentId, commandKey: intent.commandKey,
      approvedRevision: intent.approvedRevision, channel: "google_ads", campaignType: "google_search",
      requestedBy: { id: intent.requestedBy.id, name: intent.requestedBy.name, role: intent.requestedBy.role },
      authorizedBy: { id: intent.authorizedBy.id, name: intent.authorizedBy.name, at: intent.authorizedBy.at },
      plannedObjects: plannedFor(plan),
      deploymentMarker: intent.deploymentMarker,
    });
    expect(settledAgain.disposition).toBe("already_settled");
    expect(settledAgain.mayCallProvider).toBe(false);
  });

  test("16. a budget is recorded with its identifier and never marked stopped", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    const out = await creation.createPaused(createArgs(plan), deps());
    const objects = out.deployment.externalObjects;

    const budget = objects.find((o) => o.role === "budget");
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       A budget has no status saying whether anything is being shown. The old
       contract asked every object "were you confirmed paused", so a budget
       could only be recorded false — which reads as "we checked and it is
       running" — or fabricated true. */
    expect(budget.providerObjectId).toBeTruthy();
    expect(budget.deliveryStateApplies).toBe(false);
    expect(budget.nonDeliveringConfirmed).toBeNull();
    expect(budget.stateReadAt).toBeNull();

    /* Every object that DOES have a delivery state was read back. */
    const capable = objects.filter((o) => o.deliveryStateApplies);
    expect(capable.length).toBeGreaterThanOrEqual(5);
    for (const o of capable) {
      expect(o.nonDeliveringConfirmed).toBe(true);
      expect(o.stateReadAt).toBeTruthy();
      expect(o.observedState).toBe("PAUSED");
    }

    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({}))._id,
    });
    expect(attempt.deliveryObjectsNonDeliveringConfirmed).toBe(true);

    const raw = await MarketingCampaignDeploymentAttemptResult.findOne({}).lean();
    expect(raw.allPausedConfirmed).toBeUndefined();
    expect(raw.deliveryObjectsNonDeliveringConfirmed).toBe(true);
  });

  test("17. no operation anywhere can set an object delivering, or change anything", async () => {
    /* ── 1. THE WORD IS NOT IN THE FILE ───────────────────────────────────
       A value that is never written cannot be written by a typo. */
    const src = codeOf("services/marketing/channels/googleSearchBundle.js");
    expect(src).not.toContain("ENABLED");

    /* ── 2. THE BOUNDARY IS CLOSED ────────────────────────────────────────
       One write operation. No generic mutate, no caller-supplied resource,
       URL, method or operation name — and nothing exported that could be one. */
    const exported = Object.keys(bundleClient).filter((k) => typeof bundleClient[k] === "function");
    expect(exported.sort()).toEqual([
      "assertBundleIntegrity", "assertExclusionIntegrity", "assertNonDelivering",
      "buildBundle", "createPausedAtomic",
    ]);
    for (const name of exported) {
      expect(name).not.toMatch(/mutate|post|request|fetch|call|update|activate|enable|publish/i);
    }

    /* ── 3. ONLY `create`, AND ONLY THE DECLARED UNIONS ───────────────────
       Checked over the built envelope, so "this cannot change an existing
       object" is a property of the bytes rather than of the source. */
    const plan = planObject();
    const mapped = mapper.map({
      plan,
      account: { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCOUNT },
      resolvedTargeting: liveTargeting(plan),
    });
    const built = bundleClient.buildBundle({
      customerId: ACCOUNT,
      marker: marker.markerFor(markerIdentity(plan)),
      mapping: mapped.mapping,
      resolvedTargeting: liveTargeting(plan),
    });
    for (const op of built.operations) {
      const key = Object.keys(op)[0];
      expect(bundleClient.ALLOWED_OPERATION_KEYS).toContain(key);
      expect(Object.keys(op[key])).toEqual(["create"]);
    }
    expect(JSON.stringify(built.operations)).not.toMatch(/"(update|remove)"\s*:/);

    /* And an envelope carrying an update is refused by the integrity check
       rather than sent. */
    expect(() => bundleClient.assertBundleIntegrity({
      operations: [{ campaignOperation: { update: { status: "PAUSED" } } }],
      account: ACCOUNT,
      targeting: liveTargeting(plan),
    })).toThrow(/only creates/i);

    /* ── 4. NOTHING DELIVERING, AT ANY DEPTH ─────────────────────────────── */
    for (const payload of [
      { status: "ENABLED" },
      { status: "PAUSED", ad: { status: "ENABLED" } },
      { status: "PAUSED", keyword: { text: "x", status: "ENABLED" } },
      { status: "" },
    ]) {
      expect(() => bundleClient.assertNonDelivering(payload, { operation: "t" }))
        .toThrow(/created stopped/i);
    }

    /* ── 5. AND THE HTTP LAYER STILL REFUSES A MUTATION THAT DID NOT ASK ─── */
    const http = require("../../services/marketing/channels/channelHttp");
    expect(() => http.assertMutation({ method: "POST", mutationIntent: false, operation: "x" })).toThrow();
    expect(() => http.assertMutation({ method: "DELETE", mutationIntent: true, operation: "x" })).toThrow();
    expect(() => http.assertReadOnly({ method: "POST", readIntent: false, operation: "x" })).toThrow();

    /* ── 6. AND NO ROUTE OFFERS ACTIVATION ───────────────────────────────── */
    const routes = codeOf("routes/CMS_Routes/Marketing/campaignDeployment.js");
    expect(routes).not.toMatch(/router\.(post|patch|put)\([^)]*activat/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   18–19. WHEN IT GOES WRONG, WITH ONE REQUEST AND NO CLEANUP
   ═══════════════════════════════════════════════════════════════════════════ */

describe("when a creation does not finish", () => {
  test("18. a lost response is not retried, not rolled back, and blocks the next creation", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    /* The validate-only pass succeeded. The create never came back. Either the
       whole campaign exists or none of it does. */
    const transport = fakeTransport({
      "googleSearchBundle.createPausedAtomic": async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); },
    });

    const out = await creation.createPaused(createArgs(plan), deps({ transport }));

    expect(out.created).toBe(false);
    expect(out.unresolved).toBe(true);
    expect(out.outcome).toBe("unknown");

    /* ── EXACTLY ONE WRITE ATTEMPT ────────────────────────────────────────
       A request that timed out may have succeeded; a retry would create a
       second complete campaign with nothing recording the first. */
    expect(transport.calls.filter((c) => c.operation === "googleSearchBundle.createPausedAtomic"))
      .toHaveLength(1);

    /* ── AND NO CLEANUP, BECAUSE THERE IS NO CLEANUP PATH ─────────────────
       The bundle was atomic. There is nothing partial to compensate for, and
       removing "what GRAV thinks it created" would remove objects it cannot
       even name. */
    expect(out.rollback.attempted).toBe(false);
    expect(JSON.stringify(transport.calls)).not.toMatch(/"remove"/);

    /* ── THE ATTEMPT STAYS OPEN, WHICH IS WHAT BLOCKS THE NEXT CALL ──────── */
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
    const deployment = await MarketingCampaignDeployment.findOne({});
    expect((await attempts.hasUnresolvedAttempt({ companyId: A, deploymentId: deployment._id })).unresolved)
      .toBe(true);

    /* And the one thing that can answer the question is recorded and published. */
    expect(marker.looksLikeMarker(out.deploymentMarker)).toBe(true);
    expect(out.reconcileBy.deploymentMarker).toBe(out.deploymentMarker);
    expect(out.reconcileBy.means).toMatch(/matching NAME proves nothing/i);
    expect(deployment.deploymentMarker).toBe(out.deploymentMarker);

    /* ── ONE COMMAND, AT MOST ONE PROVIDER WRITE WHILE UNRESOLVED ─────────
       A fresh request identity is refused earlier still: this plan revision
       already has a deployment. */
    const second = fakeTransport();
    const fresher = await creation.createPaused(
      createArgs(plan, { idempotencyKey: fresh("deploy") }), deps({ transport: second }),
    ).catch((e) => e);
    expect(fresher.code).toBe("CONFLICT");
    expect(second.calls).toHaveLength(0);

    /* And the SAME identity is refused because the outcome is unknown. */
    const retried = fakeTransport();
    const openIntent = await MarketingCampaignDeploymentAttemptIntent.findOne({}).lean();
    const err = await creation.createPaused(
      createArgs(plan, { idempotencyKey: openIntent.commandKey }), deps({ transport: retried }),
    ).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED");
    expect(retried.calls).toHaveLength(0);
  });

  test("19. a refusal creates nothing, claims nothing, and undoes nothing", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    /* The channel answered, and the answer was no. Because the request was
       all-or-nothing, none of the bundle exists. */
    const transport = fakeTransport({
      "googleSearchBundle.validateOnly": async () => { throw fail("CHANNEL_MALFORMED_RESPONSE", "policy"); },
    });

    const out = await creation.createPaused(createArgs(plan), deps({ transport }));

    expect(out.created).toBe(false);
    expect(out.outcome).toBe("failed");

    /* ── NOT ONE OBJECT CLAIMED ───────────────────────────────────────────
       A failure that claimed an external object would send somebody hunting for
       something that was never created. */
    expect(out.deployment.externalObjects).toEqual([]);
    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({}))._id,
    });
    expect(attempt.resolved).toBe(true);
    expect(attempt.outcome).toBe("failed");
    expect(attempt.objects).toEqual([]);

    /* ── AND NO COMPENSATING DELETE ───────────────────────────────────────
       There is nothing to delete, and no code path that could. */
    expect(out.rollback.attempted).toBe(false);
    expect(out.rollback.complete).toBe(true);
    expect(out.rollback.means).toMatch(/all-or-nothing/i);
    expect(JSON.stringify(transport.calls)).not.toMatch(/"remove"/);

    /* The refusal happened at the validate-only pass, so the create was never
       sent at all. */
    expect(transport.calls.map((c) => c.operation)).toEqual(["googleSearchBundle.validateOnly"]);

    /* A settled failure does NOT block the next attempt the way an unresolved
       one does — GRAV knows nothing was created. */
    expect((await attempts.hasUnresolvedAttempt({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({}))._id,
    })).unresolved).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   20–37. TARGETING IS RESOLVED, OR NOTHING IS CREATED
   ───────────────────────────────────────────────────────────────────────────
   The release blocker these are for: a Search campaign created with no location
   criteria targets EVERYWHERE. The earlier version created one and disclosed
   that the targeting had been dropped. It was stopped, so nothing was spent —
   but a stopped campaign is one button away from a running one, and the person
   pressing that button in the advertising interface is looking at a campaign
   that appears complete. They never see GRAV's disclosure.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("resolving the places and languages somebody typed", () => {
  const boundStub = { externalAccountId: ACCOUNT, loginAccountId: null, bindingId: "", bindingRevision: 0 };

  const resolveFor = (briefOver, plan = planObject({}, briefOver), over = {}) => targeting.resolve(
    { plan, bound: boundStub }, { googleAds: fakeRead(over) },
  );

  test("20. one location resolves to exactly one identifier, and keeps the name that was typed", async () => {
    const out = await resolveFor({ geoTargeting: [{ name: "India", kind: "country" }], geoExclusions: [] });

    expect(out.locations).toHaveLength(1);
    const [loc] = out.locations;
    expect(loc.outcome).toBe("resolved");
    expect(loc.criterionId).toBe("2356");
    expect(loc.resourceName).toBe("geoTargetConstants/2356");
    /* ── THE TYPED WORD SURVIVES ──────────────────────────────────────────
       "2356" is unreadable. Somebody checking GRAV against the advertising
       interface needs to see what they asked for beside what it became. */
    expect(loc.requested).toEqual({ name: "India", kind: "country" });
    expect(loc.canonicalName).toBe("India");
    expect(loc.blocksCreation).toBe(false);
  });

  test("21. several locations each resolve independently", async () => {
    const out = await resolveFor({
      geoTargeting: [
        { name: "India", kind: "country" },
        { name: "Maharashtra", kind: "region" },
        { name: "Mumbai", kind: "city" },
      ],
      geoExclusions: [],
    });

    expect(out.locations.map((l) => l.outcome)).toEqual(["resolved", "resolved", "resolved"]);
    expect(out.locations.map((l) => l.criterionId)).toEqual(["2356", "20993", "1007785"]);
    expect(out.complete).toBe(true);
  });

  test("22. a language resolves to its own identifier", async () => {
    const out = await resolveFor({ languages: ["en", "hi"] });
    expect(out.languages.map((l) => l.outcome)).toEqual(["resolved", "resolved"]);
    expect(out.languages.map((l) => l.criterionId)).toEqual(["1000", "1023"]);
    expect(out.languages[0].canonicalName).toBe("English");
  });

  test("23. a location with several matches is ambiguous, and GRAV does not choose", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       Two real places called Cambridge. Taking the first would target
       Cambridgeshire when somebody meant Massachusetts, and nobody reviews a
       criterion id — the campaign looks perfectly correct on every screen. */
    const out = await resolveFor({ geoTargeting: [{ name: "Cambridge", kind: "city" }], geoExclusions: [] });

    const [loc] = out.locations;
    expect(loc.outcome).toBe("ambiguous");
    expect(loc.criterionId).toBeNull();
    expect(loc.blocksCreation).toBe(true);
    expect(out.complete).toBe(false);

    /* The safe information a person needs to choose later: which ones, what kind
       they are, and where. No URL, no credential name, no provider error. */
    expect(loc.candidates).toEqual([
      { criterionId: "1006886", canonicalName: "Cambridge,England,United Kingdom", targetType: "City", countryCode: "GB" },
      { criterionId: "1018127", canonicalName: "Cambridge,Massachusetts,United States", targetType: "City", countryCode: "US" },
    ]);
    const flat = JSON.stringify(out);
    expect(flat).not.toMatch(/googleads\.googleapis|Bearer|developer-token|GOOGLE_ADS_/);
  });

  test("24. an ambiguous language is ambiguous too", async () => {
    const out = await resolveFor({ languages: ["xx"] });
    expect(out.languages[0].outcome).toBe("ambiguous");
    expect(out.languages[0].criterionId).toBeNull();
    expect(out.languages[0].candidates).toHaveLength(2);
    expect(out.complete).toBe(false);
  });

  test("25. a location the channel does not know is not found, and an outage is not the same thing", async () => {
    const missing = await resolveFor({ geoTargeting: [{ name: "Atlantis", kind: "city" }], geoExclusions: [] });
    expect(missing.locations[0].outcome).toBe("not_found");
    expect(missing.locations[0].detail).toMatch(/spelled differently/i);

    /* ── AN OUTAGE IS NOT A WRONG NAME ────────────────────────────────────
       Reporting it as not_found sends somebody to re-spell a location that was
       correct, and the campaign still would not be created. */
    const down = await resolveFor(
      { geoTargeting: [{ name: "India", kind: "country" }], geoExclusions: [] },
      undefined,
      { findGeoTargets: async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); } },
    );
    expect(down.locations[0].outcome).toBe("provider_unavailable");
    expect(down.locations[0].blocksCreation).toBe(true);
    expect(down.locations[0].detail).toMatch(/did not answer/i);

    /* An area drawn on a map is neither: GRAV holds no centre and no distance,
       so it cannot express one, and mapping it to the city at its centre would
       cover a different area than the one somebody drew. */
    const radius = await resolveFor({ geoTargeting: [{ name: "Near the depot", kind: "radius" }], geoExclusions: [] });
    expect(radius.locations[0].outcome).toBe("unsupported");
  });

  test("26. a language the channel does not offer is not found", async () => {
    const out = await resolveFor({ languages: ["zz"] });
    expect(out.languages[0].outcome).toBe("not_found");
    expect(out.complete).toBe(false);
  });

  test("27. the kind of place narrows a name that would otherwise be ambiguous", async () => {
    /* Cambridge is a city in the fake, and nothing else. Asking for a COUNTRY of
       that name finds nothing rather than silently returning the city — the
       query itself is narrowed, so this is the real behaviour and not a filter
       applied afterwards. */
    const asCountry = await resolveFor({ geoTargeting: [{ name: "Cambridge", kind: "country" }], geoExclusions: [] });
    expect(asCountry.locations[0].outcome).toBe("not_found");

    const asCity = await resolveFor({ geoTargeting: [{ name: "Mumbai", kind: "city" }], geoExclusions: [] });
    expect(asCity.locations[0].outcome).toBe("resolved");
  });
});

describe("what the targeting gate refuses", () => {
  const boundStub = { externalAccountId: ACCOUNT, loginAccountId: null, bindingId: "", bindingRevision: 0 };
  const resolveFor = (briefOver) => targeting.resolve(
    { plan: planObject({}, briefOver), bound: boundStub }, { googleAds: fakeRead() },
  );

  test("28. no location at all is refused, because no location means everywhere", async () => {
    const out = await resolveFor({ geoTargeting: [], geoExclusions: [] });
    expect(out.complete).toBe(false);
    const blocker = out.blockers.find((b) => b.code === "GEO_NONE_SELECTED");
    expect(blocker.message).toMatch(/shown everywhere in the world/i);
  });

  test("29. a place that is both targeted and excluded is refused", async () => {
    /* ── WHY NOT JUST SEND BOTH ───────────────────────────────────────────
       The channel accepts both and resolves the conflict by its own rules.
       Whichever way it resolves, one of the two things somebody asked for is not
       happening, and nothing on any screen says which. */
    const out = await resolveFor({
      geoTargeting: [{ name: "India", kind: "country" }, { name: "Goa", kind: "region" }],
      geoExclusions: [{ name: "Goa", kind: "region" }],
    });
    expect(out.complete).toBe(false);
    const clash = out.blockers.find((b) => b.code === "GEO_INCLUDED_AND_EXCLUDED");
    expect(clash.message).toMatch(/both targeted and excluded/i);
  });

  test("30. an exclusion that cannot be resolved blocks creation just as an inclusion does", async () => {
    const out = await resolveFor({
      geoTargeting: [{ name: "India", kind: "country" }],
      geoExclusions: [{ name: "Cambridge", kind: "city" }],
    });
    expect(out.complete).toBe(false);
    expect(out.blockers.map((b) => b.code)).toContain("GEOEXCLUSIONS_AMBIGUOUS");
    /* An unresolvable EXCLUSION is the more dangerous of the two: carrying on
       would create a campaign that runs in the place somebody said to avoid. */
    expect(out.exclusions[0].blocksCreation).toBe(true);
  });

  test("31. an excluded place stays excluded, all the way to the request", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport();

    await creation.createPaused(createArgs(plan), deps({ transport }));

    const criteria = transport.calls[1].data.mutateOperations
      .filter((o) => o.campaignCriterionOperation)
      .map((o) => o.campaignCriterionOperation.create);

    const included = criteria.filter((l) => l.location && l.negative === false);
    const excluded = criteria.filter((l) => l.location && l.negative === true);
    expect(included.map((l) => l.location.geoTargetConstant)).toEqual(["geoTargetConstants/2356"]);
    expect(excluded.map((l) => l.location.geoTargetConstant)).toEqual(["geoTargetConstants/20981"]);

    /* ── AND THE ENVELOPE IS CHECKED BEFORE IT IS SENT ────────────────────
       Google's proto3 JSON omits a false boolean, so an exclusion that lost its
       flag and an inclusion are the same bytes. A location with no flag is
       refused rather than sent as an inclusion. */
    expect(() => bundleClient.assertExclusionIntegrity(
      { location: { geoTargetConstant: "geoTargetConstants/20981" } },
      { operation: "t", expectNegative: false },
    )).toThrow(/without saying whether it is targeted or excluded/i);

    expect(() => bundleClient.assertExclusionIntegrity(
      { location: { geoTargetConstant: "geoTargetConstants/20981" }, negative: false },
      { operation: "t", expectNegative: true },
    )).toThrow(/excluded location as a targeted one/i);

    /* A language cannot be excluded in the channel at all. */
    expect(() => bundleClient.assertExclusionIntegrity(
      { language: { languageConstant: "languageConstants/1000" } },
      { operation: "t", expectNegative: true },
    )).toThrow(/no way to exclude a language/i);

    /* ── AND AN ENVELOPE WHOSE TARGETING DRIFTED IS REFUSED WHOLESALE ─────
       Counted off the built operations against the resolution, so a criterion
       that was dropped or flipped between the mapper and the wire never
       reaches the one request that creates anything. */
    const plain = planObject();
    const mapped = mapper.map({
      plan: plain,
      account: { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCOUNT },
      resolvedTargeting: liveTargeting(plain),
    });
    const built = bundleClient.buildBundle({
      customerId: ACCOUNT,
      marker: marker.markerFor(markerIdentity(plain)),
      mapping: mapped.mapping,
      resolvedTargeting: liveTargeting(plain),
    });
    const tampered = built.operations.map((op) => {
      if (!op.campaignCriterionOperation?.create?.location) return op;
      if (op.campaignCriterionOperation.create.negative !== true) return op;
      return {
        campaignCriterionOperation: {
          create: { ...op.campaignCriterionOperation.create, negative: false },
        },
      };
    });
    expect(() => bundleClient.assertBundleIntegrity({
      operations: tampered, account: ACCOUNT, targeting: liveTargeting(plain),
    })).toThrow(/does not match the targeting that was approved/i);
  });

  test("32. a blocked preflight writes nothing, anywhere", async () => {
    await bindAccount();
    /* Ambiguous location: two places called Cambridge. */
    const plan = await approvedPlan({ geoTargeting: [{ name: "Cambridge", kind: "city" }] });
    const transport = fakeTransport();

    const pre = await preflightService.preflight({ companyId: A, plan }, deps({ transport }));
    expect(pre.creationReady).toBe(false);
    expect(pre.targeting.allApprovedTargetingCanBeApplied).toBe(false);
    expect(pre.checks.find((c) => c.code === "targeting_resolvable").status).toBe("failed");

    const err = await creation.createPaused(createArgs(plan), deps({ transport })).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");

    /* ── NOT ONE OBJECT, NOT ONE ROW ──────────────────────────────────────
       No budget, no campaign, no ad group, no ad, no keyword, no criterion — and
       no attempt intent and no deployment record either. The refusal happens
       while GRAV has still written nothing. */
    expect(transport.calls).toHaveLength(0);
    expect(transport.created).toHaveLength(0);
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("33. the created criteria carry the resolved identifiers, and are read back", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const out = await creation.createPaused(createArgs(plan), deps());

    expect(out.created).toBe(true);
    expect(out.outcome).toBe("succeeded");
    expect(out.targetingConfirmed).toBe(true);

    const criteria = out.deployment.externalObjects
      .filter((o) => ["location_target", "language_target"].includes(o.role));
    expect(criteria).toHaveLength(3);

    for (const c of criteria) {
      /* A criterion is a rule, not an object that delivers. It gets no invented
         delivery state — the same rule the budget established. */
      expect(c.deliveryStateApplies).toBe(false);
      expect(c.nonDeliveringConfirmed).toBeNull();
      expect(c.stateReadAt).toBeNull();
      /* But it IS asked the question it does have an answer to, and that answer
         came from a read rather than from the create response. */
      expect(typeof c.negative).toBe("boolean");
      expect(c.negativeConfirmed).toBe(true);
      expect(c.displayName).toBeTruthy();
    }

    const excluded = criteria.filter((c) => c.negative === true);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].requestedName).toBe("Goa");
  });

  test("34. a read-back that disagrees is never settled as success", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    /* Each of these is a campaign the channel accepted and that is NOT what was
       approved. Every one of them would look perfectly correct on a provider
       screen, and every one of them is a different kind of harm. */
    const cases = [
      [{ flipExclusions: true }, /exclusion|targeting/i],
      [{ campaignStatus: "ENABLED" }, /stopped/i],
      [{ adGroupStatus: "ENABLED" }, /stopped/i],
      [{ dropCriteria: ["geoTargetConstants/2356"] }, /location/i],
      [{ dropCriteria: ["languageConstants/1000"] }, /language/i],
      [{ dropKeywords: ["hotel uniforms"] }, /search term/i],
      [{ dropMarkerLink: true }, /marker/i],
    ];

    for (const [account, expected] of cases) {
      await MarketingCampaignDeployment.deleteMany({});
      const fresh_plan = await approvedPlan();
      const transport = fakeTransport();

      const out = await creation.createPaused(
        createArgs(fresh_plan), deps({ transport, account }),
      );

      /* Created — the channel accepted it and named the objects — but NOT a
         success, and never `paused_confirmed`. */
      expect(out.created).toBe(true);
      expect(out.outcome).toBe("partially_created");
      expect(out.targetingConfirmed).toBe(false);
      expect(out.deployment.state).toBe("partially_created");
      expect(out.requiresReconciliation).toBe(true);
      expect(out.reconciliation.outcome).toBe("one_incomplete_or_mismatched_bundle");
      expect(out.reconciliation.needsAdministrator).toBe(true);
      expect(JSON.stringify(out.reconciliation.mismatches)).toMatch(expected);
      /* Every identifier the response gave is kept, so somebody can find them. */
      expect(out.deployment.externalObjects.length).toBeGreaterThan(0);
    }
  });

  test("35. a read-back that could not be made is not a confirmation either", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport();

    /* The create succeeded. The read-back did not answer. Objects exist and
       GRAV cannot vouch for them. */
    const out = await creation.createPaused(
      createArgs(plan), deps({ transport, account: { unavailable: true } }),
    );

    expect(out.created).toBe(true);
    expect(out.outcome).toBe("partially_created");
    expect(out.reconciliation.outcome).toBe("provider_unavailable");
    expect(out.deployment.state).toBe("partially_created");
    expect(out.deployment.deliveryObjectsNonDeliveringConfirmedAt).toBeNull();

    /* Nothing was claimed as stopped. */
    for (const o of out.deployment.externalObjects.filter((x) => x.deliveryStateApplies)) {
      expect(o.nonDeliveringConfirmed).toBe(false);
      expect(o.stateReadAt).toBeNull();
    }

    /* And no compensating delete was attempted on the strength of a read that
       may itself be the thing that is wrong. */
    expect(JSON.stringify(transport.calls)).not.toMatch(/"remove"/);
  });

  test("36. a resolution is stale when the plan revision or the bound account changes", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    const first = await preflightService.preflight({ companyId: A, plan }, deps());
    expect(first.creationReady).toBe(true);
    const fingerprint = first.targeting.fingerprint;
    expect(first.targeting.resolvedFor.approvedRevision).toBe(plan.revision);
    expect(first.targeting.resolvedFor.externalAccountId).toBe(ACCOUNT);

    /* ── A DIFFERENT REVISION IS A DIFFERENT RESOLUTION ───────────────────
       Even with identical targeting: the resolution is evidence about one
       version of one plan, and carrying it forward would mean targeting
       confirmed against a plan nobody approved. */
    const laterRevision = { ...plan.toObject(), revision: plan.revision + 1 };
    const after = await targeting.resolve(
      { plan: laterRevision, bound: { externalAccountId: ACCOUNT, loginAccountId: null, bindingId: "", bindingRevision: 0 } },
      deps(),
    );
    expect(after.fingerprint).not.toBe(fingerprint);

    /* And so is a different account. */
    const otherAccount = await targeting.resolve(
      { plan, bound: { externalAccountId: MANAGER, loginAccountId: null, bindingId: "", bindingRevision: 0 } },
      deps(),
    );
    expect(otherAccount.fingerprint).not.toBe(fingerprint);

    /* A creation quoting a fingerprint the plan no longer has is refused, with
       nothing sent. */
    const transport = fakeTransport();
    const err = await creation.createPaused(
      createArgs(plan, { expectedTargetingFingerprint: "a-fingerprint-from-an-old-screen" }),
      deps({ transport }),
    ).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
    expect(transport.calls).toHaveLength(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
  });

  test("37. a rebound account invalidates an earlier resolution, and resolution is company-scoped", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    const before = await preflightService.preflight({ companyId: A, plan }, deps());
    expect(before.creationReady).toBe(true);

    /* Rebinding to a different account is a new decision about where money is
       spent. A resolution made before it belongs to the old account. */
    await binding.bind({
      companyId: A, channel: "google_ads",
      payload: { externalAccountId: MANAGER }, actor: ADMIN,
    }, deps());

    const after = await preflightService.preflight({ companyId: A, plan }, deps());
    expect(after.targeting.resolvedFor.externalAccountId).toBe(MANAGER);
    expect(after.targeting.fingerprint).not.toBe(before.targeting.fingerprint);

    const transport = fakeTransport();
    const stale = await creation.createPaused(
      createArgs(plan, { expectedTargetingFingerprint: before.targeting.fingerprint }),
      deps({ transport }),
    ).catch((e) => e);
    expect(stale.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
    expect(transport.calls).toHaveLength(0);

    /* ── AND ANOTHER COMPANY REACHES NONE OF IT ───────────────────────────
       A second company has no binding of its own, so it cannot deploy — it does
       not inherit this one's account. */
    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    await expect(binding.forDeployment({ companyId: other._id, channel: "google_ads" }))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
    expect(await binding.current({ companyId: other._id, channel: "google_ads" })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   38–48. THE MARKER, AND RECOVERING A LOST RESPONSE WITH IT
   ───────────────────────────────────────────────────────────────────────────
   One atomic request went out and no answer came back. Either the whole
   campaign exists or none of it does. Everything here is about answering that
   question honestly — and about the three answers GRAV refuses to give:
   "a campaign with the right name exists, so we're fine"; "nothing found, so
   create again"; and "two match, take the newest".
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the deployment marker", () => {
  const plan = { _id: "507f1f77bcf86cd799439011", revision: 3 };

  test("38. it is stable for an identical retry and different for everything else", async () => {
    const base = markerIdentity(plan);
    const first = marker.markerFor(base);

    /* ── STABLE ───────────────────────────────────────────────────────────
       The same command retried must produce the same marker, or a lost
       response could never be recovered: GRAV would go looking for a string
       that was never attached to anything. */
    expect(marker.markerFor(base)).toBe(first);
    expect(marker.markerFor({ ...base })).toBe(first);

    /* ── AND DIFFERENT FOR EVERY OTHER COMMAND ────────────────────────────
       One marker shared by two commands is the one failure a marker must not
       have: a reconciliation would adopt the wrong campaign. */
    const variants = {
      company: { companyId: String(new mongoose.Types.ObjectId()) },
      binding: { bindingId: "b2" },
      account: { externalAccountId: MANAGER },
      plan: { campaignDraftId: String(new mongoose.Types.ObjectId()) },
      revision: { approvedRevision: 4 },
      command: { commandKey: "a-different-request" },
      channel: { channel: "meta_ads" },
      type: { campaignType: "meta_traffic_single_image" },
    };
    const seen = new Set([first]);
    for (const [what, over] of Object.entries(variants)) {
      const other = marker.markerFor({ ...base, ...over });
      expect(other).not.toBe(first);
      expect(seen.has(other)).toBe(false);
      seen.add(other);
      void what;
    }
  });

  test("39. it carries no credential, database id, name or business text", async () => {
    const base = markerIdentity(plan, { commandKey: "winter-uniforms-redundancy-2026" });
    const value = marker.markerFor(base);

    /* Shape: a version prefix and a hex digest, and nothing else. An advertising
       account is visible to agencies and contractors, and a label is visible to
       all of them. */
    expect(value).toMatch(/^GRAV-D1-[0-9a-f]{32}$/);
    expect(value.length).toBeLessThanOrEqual(marker.LABEL_NAME_MAX);

    for (const secret of [
      String(A), base.campaignDraftId, base.bindingId, ACCOUNT,
      "winter", "uniforms", "redundancy", "google_ads", "google_search",
      process.env.MARKETING_CHANNEL_ID_SECRET,
    ]) {
      expect(value).not.toContain(secret);
    }

    /* An incomplete identity is refused rather than producing a stable-looking
       marker that every incomplete command would share. */
    for (const missing of ["companyId", "externalAccountId", "campaignDraftId", "commandKey", "approvedRevision"]) {
      expect(() => marker.markerFor({ ...base, [missing]: missing === "approvedRevision" ? 0 : "" }))
        .toThrow(/full identity/i);
    }
  });

  test("40. the same marker is attached to the campaign inside the one request", async () => {
    await bindAccount();
    const approved = await approvedPlan();
    const transport = fakeTransport();

    const out = await creation.createPaused(createArgs(approved), deps({ transport }));

    const ops = transport.calls[1].data.mutateOperations;
    const label = ops.find((o) => o.labelOperation).labelOperation.create;
    const link = ops.find((o) => o.campaignLabelOperation).campaignLabelOperation.create;
    const campaign = ops.find((o) => o.campaignOperation).campaignOperation.create;

    expect(label.name).toBe(out.deploymentMarker);
    expect(link.label).toBe(label.resourceName);
    expect(link.campaign).toBe(campaign.resourceName);

    /* ── AND IT IS NOT THE CAMPAIGN NAME ──────────────────────────────────
       The name is the customer-facing thing a marketer reads; the marker is
       evidence. Conflating them would make the evidence editable by anybody
       with account access. */
    expect(campaign.name).not.toContain(out.deploymentMarker);
    expect(campaign.name).toContain(approved.draftRef);
  });
});

describe("reconciling a lost response", () => {
  /* Drive a creation whose response is lost, and hand back the transport so a
     test can decide what the account turns out to hold. */
  const loseTheResponse = async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport({
      "googleSearchBundle.createPausedAtomic": async ({ url, data }) => {
        /* The channel DID apply it — the test decides that by recording the
           creations — and then the connection dropped. */
        const account = url.match(/customers\/(\d+)\//)[1];
        let n = 6000;
        for (const op of data.mutateOperations) {
          const key = Object.keys(op)[0];
          n += 1;
          transport.created.push({
            key,
            resourceName: `customers/${account}/${RESOURCE_OF[key]}/${n}`,
            providerObjectId: String(n),
            payload: op[key].create,
          });
        }
        throw fail("CHANNEL_UNAVAILABLE", "no answer");
      },
    });

    const out = await creation.createPaused(createArgs(plan), deps({ transport }));
    expect(out.unresolved).toBe(true);
    return { plan, transport, lost: out };
  };

  test("41. an exact marker match recovers one complete bundle, and settles it once", async () => {
    const { plan, transport, lost } = await loseTheResponse();

    const out = await creation.reconcile({ companyId: A, plan }, deps({ transport }));

    expect(out.outcome).toBe("one_complete_bundle");
    expect(out.reconciled).toBe(true);
    expect(out.deploymentMarker).toBe(lost.deploymentMarker);
    expect(out.deployment.state).toBe("paused_confirmed");

    /* ── RECORDED AS OBSERVED, NOT CREATED ────────────────────────────────
       GRAV did not watch these appear; it went and found them. Collapsing the
       two would make a recovery indistinguishable from a deployment. */
    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({}))._id,
    });
    expect(attempt.resolved).toBe(true);
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.reasonCode).toBe("RECOVERED_BY_MARKER");
    for (const o of attempt.objects) expect(o.origin).toBe("observed");
    expect(attempt.deliveryObjectsNonDeliveringConfirmed).toBe(true);

    /* ── IDEMPOTENT ───────────────────────────────────────────────────────
       A second reconciliation writes no second account of one attempt. */
    const again = await creation.reconcile({ companyId: A, plan }, deps({ transport }));
    expect(again.outcome).toBe("nothing_outstanding");
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);

    /* ── AND IT CALLED NO WRITE OPERATION ─────────────────────────────────
       The reconciler has no access to the bundle client. */
    expect(transport.calls.filter((c) => c.operation.startsWith("googleSearchBundle")))
      .toHaveLength(2);
  });

  test("42. a campaign with a matching name but no marker proves nothing", async () => {
    const { plan, transport } = await loseTheResponse();

    /* The account holds a campaign with exactly the right name — somebody made
       it by hand, or a previous attempt was cleaned up and recreated. It does
       not carry GRAV's marker, so the marker query finds nothing. */
    const out = await creation.reconcile({ companyId: A, plan }, deps({
      transport,
      googleAds: fakeRead({
        readBundleByMarker: jest.fn(async (args) => ({ marker: args.marker, labels: [], campaigns: [] })),
        findCampaignsByName: jest.fn(async () => ([
          { providerCampaignId: "999", name: `${plan.draftRef} ${plan.name}`, status: "PAUSED" },
        ])),
      }),
    }));

    expect(out.outcome).toBe("not_found_unconfirmed");
    expect(out.reconciled).toBe(false);
    /* Unresolved, still — and explicitly not an authorisation to create. */
    expect(out.mayCreateAgain).toBe(false);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("43. an immediate not-found does not authorise another creation", async () => {
    const { plan, transport } = await loseTheResponse();

    const out = await creation.reconcile({ companyId: A, plan }, deps({
      transport, account: { empty: true },
    }));

    expect(out.outcome).toBe("not_found_unconfirmed");
    /* ── WHY THIS IS NOT "IT FAILED, TRY AGAIN" ───────────────────────────
       A channel's reads can lag its writes. Acting on an immediate empty answer
       is how a second complete campaign gets created on top of a live first. */
    expect(out.detail).toMatch(/reads can lag its writes/i);
    expect(out.mayCreateAgain).toBe(false);

    const retry = fakeTransport();
    const openIntent = await MarketingCampaignDeploymentAttemptIntent.findOne({}).lean();
    const err = await creation.createPaused(
      createArgs(plan, { idempotencyKey: openIntent.commandKey }), deps({ transport: retry }),
    ).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED");
    expect(retry.calls).toHaveLength(0);
  });

  test("44. an incomplete or mismatched bundle stays unresolved and asks for a person", async () => {
    const cases = [
      [{ dropKeywords: ["hotel uniforms"] }, "KEYWORDS_DIFFER"],
      [{ campaignStatus: "ENABLED" }, "CAMPAIGN_NOT_STOPPED"],
      [{ adGroupStatus: "ENABLED" }, "AD_GROUP_NOT_STOPPED"],
      [{ dropCriteria: ["geoTargetConstants/2356"] }, "LOCATIONS_DIFFER"],
      [{ dropCriteria: ["languageConstants/1000"] }, "LANGUAGES_DIFFER"],
      [{ flipExclusions: true }, "EXCLUSION_BECAME_INCLUSION"],
      [{ dropMarkerLink: true }, "MARKER_RELATIONSHIP_MISSING"],
    ];

    for (const [account, code] of cases) {
      await MarketingCampaignDeployment.deleteMany({});
      const { plan, transport } = await loseTheResponse();

      const out = await creation.reconcile({ companyId: A, plan }, deps({ transport, account }));

      expect(out.outcome).toBe("one_incomplete_or_mismatched_bundle");
      expect(out.reconciled).toBe(false);
      expect(out.needsAdministrator).toBe(true);
      expect(out.mismatches.map((m) => m.code)).toContain(code);
      /* Nothing invented, nothing settled, nothing authorised. */
      expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
      expect(out.mayCreateAgain).toBe(false);
    }
  });

  test("45. several campaigns wearing one marker require a person, and GRAV picks none", async () => {
    const { plan, transport } = await loseTheResponse();

    const out = await creation.reconcile({ companyId: A, plan }, deps({
      transport, account: { duplicate: true },
    }));

    expect(out.outcome).toBe("multiple_matches");
    expect(out.needsAdministrator).toBe(true);
    expect(out.campaigns).toHaveLength(2);
    /* ── NOT THE NEWEST, NOT THE NEAREST ──────────────────────────────────
       Choosing would mean a machine deciding which of somebody's real campaigns
       to adopt and which to orphan. */
    expect(out.campaign).toBeNull();
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("46. a channel that does not answer leaves the attempt exactly where it was", async () => {
    const { plan, transport } = await loseTheResponse();

    const out = await creation.reconcile({ companyId: A, plan }, deps({
      transport, account: { unavailable: true },
    }));

    expect(out.outcome).toBe("provider_unavailable");
    expect(out.reconciled).toBe(false);
    /* Not an empty account. */
    expect(out.detail).toMatch(/did not answer/i);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
    expect((await attempts.hasUnresolvedAttempt({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({}))._id,
    })).unresolved).toBe(true);
  });

  test("47. another company's account cannot satisfy this reconciliation", async () => {
    const { plan } = await loseTheResponse();

    /* A second company has no binding of its own, so there is no account for it
       to reconcile against — it does not inherit this one's. */
    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    await expect(creation.reconcile({ companyId: other._id, plan }, deps()))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });

    /* And the marker itself is company-scoped: the same plan under another
       company derives a different one, so even a shared account could not
       produce a match. */
    const mine = marker.markerFor(markerIdentity(plan));
    const theirs = marker.markerFor(markerIdentity(plan, { companyId: String(other._id) }));
    expect(theirs).not.toBe(mine);
  });

  test("48. nothing outside the bundle client can reach a generic provider mutate", async () => {
    /* ── A STRUCTURAL PROOF, NOT A REVIEW ─────────────────────────────────
       The boundary is only worth anything if a future contributor cannot route
       around it by importing the transport somewhere convenient. */
    const fs2 = require("fs");
    const pathMod = require("path");
    const root = pathMod.join(__dirname, "../..");

    const walk = (dir) => fs2.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.isFile() && full.endsWith(".js") ? [full] : [];
    });

    const files = [
      ...walk(pathMod.join(root, "services/marketing")),
      ...walk(pathMod.join(root, "routes/CMS_Routes/Marketing")),
    ];

    const BUNDLE = pathMod.join(root, "services/marketing/channels/googleSearchBundle.js");
    /* The HTTP layer DEFINES the write gate; it is the thing being guarded, not
       a caller of it. Everything else is a caller. */
    const GATE = pathMod.join(root, "services/marketing/channels/channelHttp.js");
    /* Each channel has exactly one purpose-specific write client, and each is
       allowed to name its own mutate path and nothing else. Meta's is checked
       by its own suite; what matters here is that it is not a SECOND door into
       Google. */
    const META_WRITER = pathMod.join(root, "services/marketing/channels/metaAdsWriteClient.js");

    for (const file of files) {
      if (file === BUNDLE || file === GATE || file === META_WRITER) continue;
      const src = fs2.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      /* ── NO MARKETING FILE BUT THE BUNDLE CLIENT CAN REACH A MUTATE ────
         The read clients legitimately name the provider's host — reads are not
         the danger. What no other file may have is a mutate endpoint, a mutate
         envelope, or the flag that asks the HTTP layer for permission to
         write. */
      expect(src).not.toMatch(/:mutate/);
      expect(src).not.toMatch(/mutateOperations/);
      expect(src).not.toMatch(/mutationIntent/);
    }

    /* The bundle client itself has exactly one mutate path, and it is a
       constant rather than anything a caller contributes to. */
    const bundleSrc = codeOf("services/marketing/channels/googleSearchBundle.js");
    expect(bundleSrc.match(/:mutate/g)).toHaveLength(1);
    expect(bundleSrc).toMatch(/const MUTATE_PATH = "googleAds:mutate"/);

    /* And the reconciler — the thing that runs after a lost response, when the
       temptation to "just fix it" is highest — cannot even see the client. */
    const reconcilerSrc = codeOf("services/marketing/deployment/bundleReconciliation.service.js");
    expect(reconcilerSrc).not.toMatch(/googleSearchBundle/);
    expect(Object.keys(reconciler)).not.toContain("createPausedAtomic");

    /* The old sequential client is gone, and nothing imports it. */
    expect(fs2.existsSync(pathMod.join(root, "services/marketing/channels/googleAdsWriteClient.js"))).toBe(false);
    for (const file of files) {
      expect(fs2.readFileSync(file, "utf8")).not.toMatch(/googleAdsWriteClient/);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE ROUTES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the deployment routes", () => {
  test("no raw provider error, token, request body or secret name reaches the browser", async () => {
    /* A binding refusal that names a credential must not echo the value. */
    const bad = await call("/advertising-accounts/google_ads", {
      method: "POST",
      body: { externalAccountId: ACCOUNT, note: "1//0gXlongrefreshtokenvaluegoeshere" },
    });
    expect(bad.status).toBe(400);
    const flat = JSON.stringify(bad.body);
    expect(flat).not.toContain("1//0gX");
    expect(flat).not.toMatch(/GOOGLE_ADS_[A-Z_]+/);
    expect(flat).not.toMatch(/googleads\.googleapis\.com/);

    /* An unbound company is told what to do, not given a provider message. */
    const none = await call("/advertising-accounts/google_ads");
    expect(none.status).toBe(200);
    expect(none.body.bound).toBe(false);
    expect(none.body.binding).toBeNull();

    /* ── A META ACCOUNT ID IS NOT A GOOGLE ONE ────────────────────────────
       The per-channel shape check is what stops somebody binding a company to
       an account that does not exist. */
    const wrongShape = await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: "123-456-7890" },
    });
    expect(wrongShape.status).toBe(400);
    expect(JSON.stringify(wrongShape.body)).toMatch(/not an advertising account identifier/i);

    /* Meta creation exists now and has its own suite. What this file cares
       about is that a Meta request never reaches the Google path: no binding,
       so it is refused before any channel is contacted, and no Google
       deployment record appears. */
    const metaCreate = await call("/campaign-drafts/x/deployment/meta_ads/create-paused", {
      method: "POST", body: { idempotencyKey: "k", expectedRevision: 1 },
    });
    expect(metaCreate.status).toBeGreaterThanOrEqual(400);
    expect(await MarketingCampaignDeployment.countDocuments({ channel: "google_ads" })).toBe(0);
  });

  /* ── DRIVING A ROUTE, WHICH INJECTS NOTHING ────────────────────────────────
     A route builds its own client, so a route test cannot hand one in. The real
     module's read operations are spied instead, which means the route, the
     preflight, the resolver and the privacy boundary all run for real — only the
     HTTP calls are replaced. This deployment holds no advertising credentials,
     so without this every route test would exercise the outage path. */
  const withFakeChannel = (over = {}) => {
    const fake = fakeRead(over);
    const spies = ["describeAccount", "findCampaignsByName", "hasConversionAction",
      "findGeoTargets", "findLanguages", "readDeliveryStates", "readCampaignCriteria",
      "readBundleByMarker", "accessibleAccounts"]
      .map((op) => jest.spyOn(googleAdsClient, op).mockImplementation(fake[op]));
    return () => spies.forEach((sp) => sp.mockRestore());
  };

  test("the preflight route publishes the targeting section and no credential", async () => {
    const restore = withFakeChannel();
    await bindAccount();
    const plan = await approvedPlan();
    const id = draftIdFor(plan);

    const res = await call(`/campaign-drafts/${id}/deployment/google_ads/preflight`);
    expect(res.status).toBe(200);

    const t = res.body.targeting;
    expect(t.requestedLocations[0]).toMatchObject({
      requested: { name: "India", kind: "country" }, outcome: "resolved", resolvedId: "2356",
    });
    expect(t.requestedExclusions[0]).toMatchObject({ outcome: "resolved", resolvedId: "20981" });
    expect(t.requestedLanguages[0]).toMatchObject({ outcome: "resolved", resolvedId: "1000" });
    expect(t.unresolved).toEqual([]);
    expect(t.allApprovedTargetingCanBeApplied).toBe(true);

    expect(res.body.creationReady).toBe(true);
    expect(res.body.activationReady).toBe(false);
    /* ── AND IT IS STILL NOT "READY TO DEPLOY" ────────────────────────────
       Nothing has been created. `creationReady` says GRAV could; nobody should
       read that as "this is live". */
    expect(res.body.deploymentReady).toBe(false);

    /* The internal resolution, with its fence, is NOT on the wire. */
    expect(res.body.__resolution).toBeUndefined();

    /* ── NOTHING A CREDENTIAL TOUCHES, AND NO RAW PROVIDER ANYTHING ──────── */
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/googleads\.googleapis|googleapis\.com|:mutate|googleAds:search/);
    expect(flat).not.toMatch(/Bearer|developer-token|login-customer-id/i);
    expect(flat).not.toMatch(/GOOGLE_ADS_[A-Z_]+|MARKETING_CHANNEL_ID_SECRET/);
    expect(flat).not.toMatch(/refreshToken|clientSecret|access_token/i);
    /* No GAQL, no Google field paths. */
    expect(flat).not.toMatch(/geo_target_constant|language_constant|SELECT /);
    restore();
  });

  test("an ambiguous location reaches the browser as safe candidates and a refusal", async () => {
    const restore = withFakeChannel();
    await bindAccount();
    const plan = await approvedPlan({ geoTargeting: [{ name: "Cambridge", kind: "city" }] });
    const id = draftIdFor(plan);

    const res = await call(`/campaign-drafts/${id}/deployment/google_ads/preflight`);
    expect(res.body.creationReady).toBe(false);
    const loc = res.body.targeting.requestedLocations[0];
    expect(loc.outcome).toBe("ambiguous");
    expect(loc.candidates).toHaveLength(2);
    expect(loc.candidates[0]).toHaveProperty("canonicalName");
    /* Enough to choose between them; nothing more. */
    for (const c of loc.candidates) {
      expect(Object.keys(c).sort()).toEqual(["canonicalName", "countryCode", "criterionId", "targetType"]);
    }

    const create = await call(`/campaign-drafts/${id}/deployment/google_ads/create-paused`, {
      method: "POST", body: { idempotencyKey: fresh("k") },
    });
    expect(create.status).toBe(422);
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(JSON.stringify(create.body)).not.toMatch(/googleapis|Bearer|GOOGLE_ADS_/);
    restore();
  });

  test("the reconcile route reports in GRAV's words and writes nothing externally", async () => {
    const restore = withFakeChannel();
    await bindAccount();
    const plan = await approvedPlan();
    const id = draftIdFor(plan);

    /* Lose the response through the real route path. */
    const lost = jest.spyOn(bundleClient, "createPausedAtomic")
      .mockImplementation(async ({ validateOnly }) => {
        if (validateOnly) return { validated: true, operationCount: 11, results: [] };
        throw fail("CHANNEL_UNAVAILABLE", "connection reset by peer at googleads.googleapis.com");
      });

    const created = await call(`/campaign-drafts/${id}/deployment/google_ads/create-paused`, {
      method: "POST", body: { idempotencyKey: fresh("k") },
    });
    expect(created.status).toBe(200);
    expect(created.body.unresolved).toBe(true);
    expect(marker.looksLikeMarker(created.body.deploymentMarker)).toBe(true);

    /* ── THE PROVIDER'S OWN WORDS DID NOT TRAVEL ──────────────────────────
       The upstream message named a host and a socket error. What reached the
       browser is GRAV's sentence. */
    const flatCreate = JSON.stringify(created.body);
    expect(flatCreate).not.toMatch(/googleapis|connection reset|peer/i);

    const status = await call(`/campaign-drafts/${id}/deployment/google_ads`);
    expect(status.body.needsReconciliation).toBe(true);
    expect(status.body.deploymentMarker).toBe(created.body.deploymentMarker);
    expect(status.body.reconcileHint).toMatch(/matching name proves nothing/i);

    lost.mockRestore();

    const res = await call(`/campaign-drafts/${id}/deployment/google_ads/reconcile`, {
      method: "POST", body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("not_found_unconfirmed");
    expect(res.body.mayCreateAgain).toBe(false);
    expect(res.body.activationAvailable).toBe(false);

    /* ── NOTHING A CREDENTIAL TOUCHES, NO GAQL, NO PROVIDER PATH ─────────── */
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/googleapis|:mutate|googleAds:search/);
    expect(flat).not.toMatch(/Bearer|developer-token|login-customer-id/i);
    expect(flat).not.toMatch(/GOOGLE_ADS_[A-Z_]+|MARKETING_CHANNEL_ID_SECRET/);
    expect(flat).not.toMatch(/SELECT |campaign_label|geo_target_constant|customers\//);

    /* A marketer may not run it: this is the step that can close an attempt. */
    const asMarketer = await call(`/campaign-drafts/${id}/deployment/google_ads/reconcile`, {
      user: MARKETER, method: "POST", body: {},
    });
    expect(asMarketer.status).toBe(403);

    restore();
  });

  test("submission, approval and preflight are untouched by the atomic change", async () => {
    const restore = withFakeChannel();

    /* ── THE THINGS THAT MUST NOT HAVE MOVED ──────────────────────────────
       This correction replaced the creation protocol. A plan's own lifecycle is
       upstream of all of it and must behave exactly as before. */
    const created = await drafts.create({
      companyId: A, user: MARKETER,
      payload: withoutKeys({
        ...PLAN, utmCampaign: fresh("winter"), idempotencyKey: fresh("k"),
        deploymentBriefs: [withoutKeys({ ...GOOGLE_BRIEF })],
      }),
    });
    expect(created.state).toBe("draft");

    const submitted = await drafts.submit({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId,
      expectedRevision: created.revision,
    });
    expect(submitted.state).toBe("awaiting_approval");

    const decided = await drafts.decide({
      companyId: A, user: ADMIN, campaignDraftId: created.campaignDraftId,
      decision: "approve", reason: "Approved.",
    });
    expect(decided.state).toBe("approved");
    /* Approval still creates nothing and starts nothing. */
    expect(decided.deployed).toBeFalsy();

    const readiness = await drafts.deploymentReadiness({
      companyId: A, campaignDraftId: created.campaignDraftId,
    });
    expect(readiness.approvalMeaning.createdAnything).toBe(false);
    expect(readiness.approvalMeaning.committedMoney).toBe(false);

    await bindAccount();
    const plan = await drafts.loadForDeployment({
      companyId: A, campaignDraftId: created.campaignDraftId,
    });
    const pre = await preflightService.preflight({ companyId: A, plan }, deps());
    expect(pre.creationReady).toBe(true);
    expect(pre.activationReady).toBe(false);
    expect(pre.targeting.allApprovedTargetingCanBeApplied).toBe(true);

    /* And a preflight still writes nothing — the atomic change did not give it
       a reason to. */
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);

    restore();
  });

  test("a marketer may see the binding but may not choose it or create with it", async () => {
    await bindAccount();
    const plan = await approvedPlan();

    const read = await call("/advertising-accounts/google_ads", { user: MARKETER });
    expect(read.status).toBe(200);
    expect(read.body.binding.externalAccountId).toBe(ACCOUNT);
    expect(read.body.mayBind).toBe(false);

    const bind = await call("/advertising-accounts/google_ads", {
      user: MARKETER, method: "POST", body: { externalAccountId: MANAGER },
    });
    expect(bind.status).toBe(403);

    /* And creating is refused for the same reason: a marketer who can plan a
       campaign is not the person who decides which account it lands in. */
    const create = await call(`/campaign-drafts/x/deployment/google_ads/create-paused`, {
      user: MARKETER, method: "POST", body: { idempotencyKey: "k" },
    });
    expect(create.status).toBe(403);
  });

  test("the creation route accepts a request identity and nothing else", async () => {
    const res = await call("/campaign-drafts/anything/deployment/google_ads/create-paused", {
      method: "POST",
      body: { idempotencyKey: "k", campaignName: "Something I chose", budgetMicros: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/campaignName|budgetMicros/);

    /* And the channel is a GRAV code, not a provider path. */
    const wrong = await call("/campaign-drafts/anything/deployment/googleads/create-paused", {
      method: "POST", body: { idempotencyKey: "k" },
    });
    expect([400, 404, 501]).toContain(wrong.status);
  });
});
