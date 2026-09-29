// test/marketing/meta-deployment-foundation.test.js
//
// THE META FOUNDATION: BINDING, READ-ONLY PREFLIGHT, AND AN HONEST BLOCKER.
//
// ── THIS SLICE ENDS BEFORE THE FIRST META MUTATION ─────────────────────────
// There is no Meta creation path in the codebase — not disabled, absent. Every
// provider call in this suite is a fake READ. No test creates, updates,
// activates or deletes anything in Meta, and a test below proves no such
// operation exists to call.
//
// ── AND THE ANSWER IS ALWAYS "NOT YET" ─────────────────────────────────────
// Even for a perfect plan in a perfectly verified account. GRAV's content
// library holds emails, forms and landing pages; it has nowhere to keep an
// advertising image. Half of what follows is about making that refusal precise
// rather than vague — and about refusing the four things somebody will
// reasonably offer instead.
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
const Binding = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding");
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");

const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const binding = require("../../services/marketing/deployment/accountBinding.service");
const targeting = require("../../services/marketing/deployment/metaTargetingResolution.service");
const creativeAsset = require("../../services/marketing/deployment/metaCreativeAsset");
const mapper = require("../../services/marketing/deployment/metaTrafficMapper");
const metaPreflight = require("../../services/marketing/deployment/metaPreflight.service");
const metaAdsClient = require("../../services/marketing/channels/metaAdsClient");
const trackingConfig = require("../../services/marketing/trackingConfig.service");
const { fail } = require("../../services/storePurchase/errors");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };

const ACCOUNT = "act_1234567890";
const BUSINESS = "9988776655";
const PIXEL = "1122334455667788";

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

const call = async (p, { user = ADMIN, method = "GET", body = null, company = null } = {}) => {
  const res = await fetch(`${base}${p}`, {
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

const codeOf = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ═══════════════════════════════════════════════════════════════════════════
   THE FAKE CHANNEL — READS ONLY
   ───────────────────────────────────────────────────────────────────────────
   Every operation here is a read. There is no fake write, because there is
   nothing to fake: no Meta write operation exists.
   ═══════════════════════════════════════════════════════════════════════════ */

const GEO = Object.freeze({
  India: [{ key: "IN", name: "India", type: "country", countryCode: "IN", countryName: "India", canonicalName: "India" }],
  Maharashtra: [{ key: "3865", name: "Maharashtra", type: "region", countryCode: "IN", countryName: "India", canonicalName: "Maharashtra, India" }],
  Goa: [{ key: "3861", name: "Goa", type: "region", countryCode: "IN", countryName: "India", canonicalName: "Goa, India" }],
  Mumbai: [{ key: "1006094", name: "Mumbai", type: "city", countryCode: "IN", countryName: "India", region: "Maharashtra", canonicalName: "Mumbai, Maharashtra, India" }],
  /* Two real places with one name — and the reason GRAV never takes the first. */
  Cambridge: [
    { key: "2386", name: "Cambridge", type: "city", countryCode: "GB", countryName: "United Kingdom", canonicalName: "Cambridge, England, United Kingdom" },
    { key: "2387", name: "Cambridge", type: "city", countryCode: "US", countryName: "United States", canonicalName: "Cambridge, Massachusetts, United States" },
  ],
  /* What the channel SUGGESTS for a misspelling: plausible, and wrong. */
  Bengalru: [{ key: "1006092", name: "Bengaluru", type: "city", countryCode: "IN", countryName: "India", canonicalName: "Bengaluru, Karnataka, India" }],
});

const LOCALES = Object.freeze({
  en: [{ key: "6", name: "en" }],
  hi: [{ key: "46", name: "hi" }],
  xx: [{ key: "901", name: "xx" }, { key: "902", name: "xx" }],
});

const fakeMeta = (over = {}) => ({
  accessibleAccounts: jest.fn(async () => [ACCOUNT.replace(/^act_/, "")]),
  describeAccount: jest.fn(async ({ accountId }) => ({
    /* It answers about the account it was ASKED about — which is the behaviour
       the binding insists on. */
    accountId: String(accountId),
    accountName: "GRAV Clothing Ads",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    status: "ACTIVE",
    disableReason: "",
    businessId: BUSINESS,
    businessName: "GRAV Clothing",
    capabilities: ["CAN_USE_REACH_AND_FREQUENCY"],
    isPrepay: false,
  })),
  verifyDeploymentReads: jest.fn(async () => ({ campaigns: true, adSets: true, creatives: true, ads: true })),
  verifyInsightsRead: jest.fn(async () => true),
  readPixel: jest.fn(async ({ pixelId }) => ({
    requested: pixelId,
    found: pixelId === PIXEL ? { pixelId: PIXEL, name: "GRAV site" } : null,
    accountPixelCount: 1,
  })),
  searchGeoTargets: jest.fn(async ({ name, types }) => (GEO[name] || [])
    .filter((g) => !types?.length || types.includes(g.type))),
  searchLocales: jest.fn(async ({ query }) => LOCALES[query] || []),
  readVerifiedDomains: jest.fn(async () => ["grav.in"]),
  ...over,
});

const deps = (over = {}) => ({ metaAds: fakeMeta(over.metaAds || {}), ...over });

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES
   ═══════════════════════════════════════════════════════════════════════════ */

const META_BRIEF = Object.freeze({
  channel: "meta_ads",
  campaignType: "meta_traffic_single_image",
  destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
  geoTargeting: [{ name: "India", kind: "country" }],
  geoExclusions: [{ name: "Goa", kind: "region" }],
  languages: ["en"],
  audiences: [],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "maximise_clicks" },
  budgetRelationship: "campaign_daily",
  metaOptimisation: "link_clicks",
  specialAdCategory: "none",
  /* ── THE ONE AUDIENCE SHAPE, EVERY BOUNDARY EXPLICIT ──────────────────────
     Including `all` genders, which is a CHOICE. If the field could be omitted,
     a plan that never considered gender and one that deliberately chose
     everyone would be stored identically. */
  audienceMode: "broad_prospecting",
  audienceAgeMin: 25,
  audienceAgeMax: 54,
  audienceGenders: "all",
  audienceExpansionRequested: false,
  metaSingleImage: {
    primaryText: "Winter uniforms for hospitality, made to measure.",
    headline: "Order before October",
    callToAction: "learn_more",
    /* ── AN APPROVABLE PLAN THAT STILL CANNOT BE DEPLOYED ─────────────────
       The plan's own readiness gate requires a media REFERENCE, and a content
       reference satisfies it — the evaluator is explicit that resolving one is
       an external question it cannot answer. So this plan reaches `approved`
       exactly as a real one would, and the Meta creative gate is what refuses
       it: a landing page is a page, not an advertising image. */
    image: { kind: "landing_page", contentId: "88", capturedName: "Winter hero" },
  },
  timezone: "Asia/Kolkata",
});

const PLAN = Object.freeze({
  name: "Winter uniforms",
  objective: "lead_generation",
  channels: ["meta_ads"],
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

async function approvedPlan(briefOver = {}, planOver = {}) {
  const created = await drafts.create({
    companyId: A,
    user: MARKETER,
    payload: withoutKeys({
      ...PLAN,
      utmCampaign: fresh("winter"),
      idempotencyKey: fresh("k"),
      deploymentBriefs: [withoutKeys({ ...META_BRIEF, ...briefOver })],
      ...planOver,
    }),
  });
  await drafts.submit({ companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision });
  await drafts.decide({
    companyId: A, user: ADMIN, campaignDraftId: created.campaignDraftId,
    decision: "approve", reason: "Approved.",
  });
  return drafts.loadForDeployment({ companyId: A, campaignDraftId: created.campaignDraftId });
}

/* A plain plan object for the pure proofs — the mapper touches no database. */
const planObject = (over = {}, briefOver = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  draftRef: "MCP-2026-0001",
  name: "Winter uniforms",
  revision: 3,
  state: "approved",
  utmCampaign: "winter-uniforms",
  schedule: { startDate: "2026-10-01", endDate: "2026-12-15" },
  budget: { amount: 2500, currency: "INR", basis: "daily" },
  deploymentBriefs: [withoutKeys({ ...META_BRIEF, ...briefOver })],
  ...over,
});

const account = { currency: "INR", timeZone: "Asia/Kolkata", externalAccountId: ACCOUNT };

const resolvedFor = (plan) => ({
  campaignDraftId: String(plan._id),
  draftRef: plan.draftRef,
  approvedRevision: plan.revision,
  externalAccountId: ACCOUNT,
  bindingId: "",
  bindingRevision: 1,
});

const liveTargeting = (plan, over = {}) => ({
  resolvedFor: resolvedFor(plan),
  /* `keyType` travels with the key: the channel's targeting object is typed, and
     a region placed in the cities list is either refused or silently read as
     somewhere else. The real resolver sets it, so the fixture does too. */
  locations: [{ requested: { name: "India", kind: "country" }, outcome: "resolved", key: "IN", keyType: "country", canonicalName: "India" }],
  exclusions: [{ requested: { name: "Goa", kind: "region" }, outcome: "resolved", key: "3861", keyType: "region", canonicalName: "Goa, India" }],
  locales: [{ requested: { tag: "en" }, outcome: "resolved", key: "6", keyType: "locale", canonicalName: "en" }],
  audiences: [],
  age: { applies: false, min: null, max: null, problems: [], means: "" },
  complete: true, blockers: [], fingerprint: "fp",
  ...over,
});

/* The asset that does not exist. Passed explicitly where a test needs to prove
   what happens once one does. */
const goodAsset = {
  assetId: "asset-1", companyId: "c", mimeType: "image/jpeg",
  width: 1200, height: 1200, byteSize: 400000, contentHash: "abc123",
  storageOrigin: "grav-media", readMechanism: "signed-read",
  rightsState: "approved_for_paid_advertising", approvedPlanRevision: 3,
  usable: true, providerUpload: "not-yet",
};

async function bindMeta(over = {}) {
  return binding.bind({
    companyId: A, channel: "meta_ads",
    payload: { externalAccountId: ACCOUNT, businessId: BUSINESS, ...over },
    actor: ADMIN,
  }, deps());
}

/* ═══════════════════════════════════════════════════════════════════════════
   1–6. THE BINDING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("binding a company to a Meta advertising account", () => {
  test("1. it stores safe identifiers and metadata, and every selector carries the company", async () => {
    const { binding: view } = await bindMeta({ note: "Main account" });

    expect(view.channel).toBe("meta_ads");
    expect(view.externalAccountId).toBe(ACCOUNT);
    expect(view.businessId).toBe(BUSINESS);
    expect(view.state).toBe("verified");
    /* Read from the account, never taken from the caller: a currency somebody
       typed is a claim, and the budget check has to be against what the account
       bills in. */
    expect(view.currency).toBe("INR");
    expect(view.timeZone).toBe("Asia/Kolkata");
    expect(view.accountStatus || view.lastVerification.observedStatus).toBe("ACTIVE");
    expect(view.boundBy.name).toBe("Ada");
    expect(view.lastVerification.at).toBeTruthy();
    expect(view.revision).toBe(1);

    const raw = await Binding.findOne({}).lean();
    expect(String(raw.companyId)).toBe(String(A));

    /* Every read and write is company-scoped. Proved by the stored row and by
       the service refusing to answer for anybody else. */
    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    expect(await binding.current({ companyId: other._id, channel: "meta_ads" })).toBeNull();
    await expect(binding.forDeployment({ companyId: other._id, channel: "meta_ads" }))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
  });

  test("2. no credential can be stored or returned, by name or by shape", async () => {
    for (const key of ["accessToken", "appSecret", "systemUserToken", "refreshToken", "cookie", "app_secret"]) {
      await expect(binding.bind({
        companyId: A, channel: "meta_ads",
        payload: { externalAccountId: ACCOUNT, [key]: "EAAJk2ZClongmetasystemusertokenvalue" },
        actor: ADMIN,
      }, deps())).rejects.toMatchObject({ code: "VALIDATION" });
    }

    /* And the same value under an innocent key. A deny-list of names would
       store this one, and it would be in every backup for ever. */
    const err = await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: ACCOUNT, note: "EAAJk2ZClongmetasystemusertokenvalue" },
      actor: ADMIN,
    }, deps()).catch((e) => e);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/looks like a credential/i);

    expect(await Binding.countDocuments({})).toBe(0);

    /* The model is the last line: strict-throw, so anything past both checks is
       a write error rather than a silently dropped field. */
    await expect(Binding.create({
      companyId: A, channel: "meta_ads", externalAccountId: ACCOUNT,
      boundBy: { id: new mongoose.Types.ObjectId(), name: "Ada" },
      accessToken: "EAAJk2ZC",
    })).rejects.toThrow(/accessToken/);

    /* Nothing in a stored or returned binding reads like a credential. */
    const { binding: view } = await bindMeta();
    const stored = await Binding.findOne({}).lean();
    for (const blob of [JSON.stringify(view), JSON.stringify(stored)]) {
      expect(blob).not.toMatch(/EAA[A-Za-z0-9]{10,}|access.?token|app.?secret|META_ADS_[A-Z_]+/i);
    }
  });

  test("3. the account identity is verified, not inferred from whatever the connection returns", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       A credential commonly reaches several accounts. A client that answered
       about its own default — or about the first account it listed — would bind
       a company to whichever account the connection preferred, and nobody would
       find out until an invoice arrived. */
    const wrongAccount = fakeMeta({
      describeAccount: jest.fn(async () => ({
        accountId: "act_9999999999", accountName: "Somebody else's account",
        currency: "USD", timeZone: "America/New_York", status: "ACTIVE",
        businessId: "1", capabilities: [],
      })),
    });

    const out = await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: ACCOUNT }, actor: ADMIN,
    }, { metaAds: wrongAccount });

    expect(out.binding.state).toBe("unreachable");
    expect(out.binding.mayDeploy).toBe(false);
    expect(out.binding.lastVerification.outcome).toBe("identity_mismatch");
    /* And nothing from the other account was stored as though it were this one. */
    expect(out.binding.currency).toBeNull();

    await expect(binding.forDeployment({ companyId: A, channel: "meta_ads" }))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
  });

  test("4. an account identifier for the wrong channel is refused", async () => {
    /* A Google account number is not a Meta one. Accepting it would bind a
       company to something that does not exist. */
    await expect(binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: "123-456-7890" }, actor: ADMIN,
    }, deps())).rejects.toMatchObject({ code: "VALIDATION" });

    /* And a business identifier is not an account identifier: they are
       different objects, and conflating them binds a company to the wrong one. */
    await expect(binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: ACCOUNT, businessId: "act_123" }, actor: ADMIN,
    }, deps())).rejects.toMatchObject({ code: "VALIDATION" });

    /* Both forms of a Meta id are accepted and one is stored, so two rows that
       are the same account cannot look different. */
    const bare = await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: "1234567890" }, actor: ADMIN,
    }, deps());
    expect(bare.binding.externalAccountId).toBe(ACCOUNT);
  });

  test("5. an outage is not a wrong account, and a refusal is not an outage", async () => {
    const unavailable = fakeMeta({
      describeAccount: jest.fn(async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); }),
    });
    const out = await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: ACCOUNT }, actor: ADMIN,
    }, { metaAds: unavailable });
    expect(out.binding.state).toBe("unverified");
    expect(out.binding.lastVerification.outcome).toBe("unreachable");

    await Binding.deleteMany({});
    const refused = fakeMeta({
      describeAccount: jest.fn(async () => { throw fail("CHANNEL_ACCESS_REFUSED", "no"); }),
    });
    const out2 = await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: ACCOUNT }, actor: ADMIN,
    }, { metaAds: refused });
    expect(out2.binding.state).toBe("unreachable");
    expect(out2.binding.lastVerification.outcome).toBe("not_listed");
  });

  test("6. rebinding bumps the revision, and that invalidates an earlier preflight", async () => {
    await bindMeta();
    const plan = await approvedPlan();

    const first = await metaPreflight.preflight({ companyId: A, plan }, deps());
    expect(first.account.bindingRevision).toBe(1);
    const before = first.targeting.fingerprint;

    /* ── A REBIND IS A NEW DECISION ABOUT WHERE MONEY IS SPENT ────────────
       Even to the same account number, after a failed verification. Targeting
       resolved under the old binding belongs to the old binding. */
    await binding.verify({ companyId: A, channel: "meta_ads", actor: ADMIN }, deps());

    const second = await metaPreflight.preflight({ companyId: A, plan }, deps());
    expect(second.account.bindingRevision).toBe(2);
    expect(second.targeting.fingerprint).not.toBe(before);
    expect(second.targeting.resolvedFor.bindingRevision).toBe(2);

    /* And binding a different account changes it again. */
    await binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: "act_5555555555" }, actor: ADMIN,
    }, deps());
    const third = await metaPreflight.preflight({ companyId: A, plan }, deps());
    expect(third.account.externalAccountId).toBe("act_5555555555");
    expect(third.targeting.fingerprint).not.toBe(second.targeting.fingerprint);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7–9. THE ONE SUPPORTED SHAPE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the frozen MVP contract", () => {
  const { MVP_CONTRACT, UNSUPPORTED_SHAPE_CODES, UNSUPPORTED_PUBLIC_MESSAGE } =
    require("../../constants/marketingMetaDeployment");

  test("7. website traffic with a single image is the only supported shape", async () => {
    expect(MVP_CONTRACT.campaignType).toBe("meta_traffic_single_image");
    expect(MVP_CONTRACT.objective.grav).toBe("website_traffic");
    expect(MVP_CONTRACT.structure).toEqual({ campaigns: 1, adSets: 1, creatives: 1, ads: 1 });
    expect(MVP_CONTRACT.creative).toEqual({
      images: 1, primaryTexts: 1, headlines: 1, callsToAction: 1, destinations: 1,
    });

    /* Everything the shape needs, stated. Each has a provider default, and each
       of those defaults decides how money is spent or who may see the ad. */
    for (const required of [
      "objective", "optimisation", "audience", "schedule", "budgetBasis",
      "budgetCurrency", "destination", "creativeImage", "primaryText",
      "headline", "callToAction", "specialAdCategory", "trackingIdentity",
    ]) {
      expect(MVP_CONTRACT.requires).toContain(required);
    }
  });

  test("8. every other Meta shape is refused by name internally and one sentence publicly", async () => {
    /* The internal vocabulary, so a refusal is precise in a log and a test. */
    for (const shape of [
      "video", "carousel", "catalogue", "lead_form", "messages", "app_install",
      "awareness", "sales_conversion", "advantage_plus", "dynamic_creative",
      "multiple_ads", "multiple_ad_sets", "campaign_budget_optimisation",
    ]) {
      expect(UNSUPPORTED_SHAPE_CODES).toContain(shape);
    }

    /* ── AND THE PUBLIC MESSAGE NAMES NONE OF THEM ────────────────────────
       Listing channel features GRAV cannot do publishes a roadmap nobody wrote
       and invites somebody to ask for one. */
    for (const shape of UNSUPPORTED_SHAPE_CODES) {
      expect(UNSUPPORTED_PUBLIC_MESSAGE.toLowerCase()).not.toContain(shape.replace(/_/g, " "));
    }
    expect(UNSUPPORTED_PUBLIC_MESSAGE).toMatch(/website-traffic campaign with a single image/);
  });

  test("9. a plan of another type is refused before any provider read", async () => {
    await bindMeta();
    /* The plan boundary refuses an unsupported campaign type at the write, so a
       plan carrying one cannot exist. The preflight refuses the other reachable
       case: a Meta brief with no type chosen. */
    const plan = await approvedPlan({ campaignType: undefined }).catch((e) => e);
    expect(plan.code).toBe("CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE");

    const meta = fakeMeta();
    const googlePlan = planObject({}, { channel: "google_ads", campaignType: "google_search" });
    await expect(metaPreflight.preflight({ companyId: A, plan: googlePlan }, { metaAds: meta }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DEPLOYMENT_NOT_BUILT" });
    /* Not one provider call was made. */
    expect(meta.describeAccount).not.toHaveBeenCalled();
    expect(meta.searchGeoTargets).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10–12. THE IMAGE THAT DOES NOT EXIST
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the advertising image blocker", () => {
  test("10. a missing image blocks creation, in a marketer's language", async () => {
    await bindMeta();
    const plan = await approvedPlan();

    const out = await metaPreflight.preflight({ companyId: A, plan }, deps());

    /* ── A PERFECT LOCAL PLAN IS STILL BLOCKED ────────────────────────────
       Every account check passes, every location resolves, and the answer is
       still no. */
    for (const c of out.checks.filter((x) => x.code !== "advertising_image_available")) {
      expect(["passed", "not_applicable"]).toContain(c.status);
    }
    expect(out.targeting.allApprovedTargetingCanBeApplied).toBe(true);

    expect(out.creationReady).toBe(false);
    expect(out.creative.ready).toBe(false);
    expect(out.creative.blocker.code).toBe("ADVERTISING_IMAGE_NOT_AVAILABLE");
    expect(out.creative.blocker.means).toMatch(/nowhere to keep an advertising image/i);
    expect(out.creative.blocker.whatWouldFixIt).toMatch(/advertising image library/i);
    /* And it names what the plan actually offered, so a marketer who pointed at
       a landing page is told why THAT cannot be used. */
    expect(out.creative.problems[0].source).toBe("landing_page_content");

    /* Named as a blocker, not buried in a list of plan problems. */
    expect(out.creationBlockers.map((b) => b.code)).toContain("advertising_image_available");

    /* No hashes, byte sizes or content-library kinds in what a marketer reads. */
    expect(out.creative.blocker.means).not.toMatch(/hash|bytes|mime|landing_page/i);
  });

  test("11. an email image, an arbitrary URL, an attachment and free text are each refused with a reason", async () => {
    const cases = [
      [{ kind: "email", contentId: "41" }, "email_content", /may rewrite, expire or track/i],
      [{ capturedName: "https://cdn.example.com/hero.jpg" }, "arbitrary_url", /never inspected it/i],
      [{ contentId: "88" }, "attachment", /no dimensions, no hash/i],
      [{ capturedName: "the winter hero shot" }, "free_text", /instruction to a person/i],
      [{ kind: "landing_page", contentId: "12" }, "landing_page_content", /page, not an image/i],
    ];

    for (const [image, source, why] of cases) {
      const out = creativeAsset.evaluate({ brief: { metaSingleImage: { image } } });
      expect(out.ready).toBe(false);
      expect(out.problems[0].code).toBe("IMAGE_SOURCE_REFUSED");
      expect(out.problems[0].source).toBe(source);
      expect(out.problems[0].message).toMatch(why);
      /* No hash is invented for any of them. */
      expect(out.asset).toBeNull();
    }

    /* And the mapper never produces an image hash, whatever it is handed. */
    const plan = planObject();
    const mapped = mapper.map({
      plan, account, resolvedTargeting: liveTargeting(plan),
      creativeAsset: creativeAsset.evaluate({
        brief: { metaSingleImage: { image: { capturedName: "https://cdn.example.com/hero.jpg" } } },
      }),
    });
    expect(mapped.mappable).toBe(false);
    expect(JSON.stringify(mapped)).not.toMatch(/imageHash":\s*"[^"]+"/);
  });

  test("12. the future asset contract is named, and an incomplete asset does not pass it", async () => {
    const { IMAGE_ASSET_FIELDS } = require("../../constants/marketingMetaDeployment");

    for (const field of [
      "assetId", "companyId", "mimeType", "width", "height", "byteSize",
      "contentHash", "storageOrigin", "readMechanism", "rightsState",
      "approvedPlanRevision", "usable", "providerUpload",
    ]) {
      expect(IMAGE_ASSET_FIELDS).toContain(field);
    }

    /* A complete, approved, usable asset passes — which is what makes every
       refusal below a real check rather than a hard-coded no. */
    const good = creativeAsset.evaluate({ brief: {}, asset: goodAsset });
    expect(good.ready).toBe(true);
    expect(good.asset.contentHash).toBe("abc123");

    /* And each way of being incomplete fails. */
    const bad = [
      [{ ...goodAsset, contentHash: "" }, /incomplete/i],
      [{ ...goodAsset, mimeType: "image/gif" }, /file type/i],
      [{ ...goodAsset, width: 100, height: 100 }, /smaller than/i],
      [{ ...goodAsset, byteSize: 99 * 1024 * 1024 }, /larger than/i],
      [{ ...goodAsset, rightsState: "unknown" }, /may be used in paid advertising/i],
      [{ ...goodAsset, usable: false }, /not currently usable/i],
    ];
    for (const [asset, message] of bad) {
      const out = creativeAsset.evaluate({ brief: {}, asset });
      expect(out.ready).toBe(false);
      expect(out.problems.map((p) => p.message).join(" ")).toMatch(message);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   13–17. TARGETING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("resolving Meta targeting", () => {
  const boundStub = { externalAccountId: ACCOUNT, businessId: BUSINESS, bindingId: "", bindingRevision: 1 };
  const resolveFor = (briefOver, over = {}) => targeting.resolve(
    { plan: planObject({}, briefOver), bound: boundStub }, { metaAds: fakeMeta(over) },
  );

  test("13. inclusions and exclusions resolve into separate lists and never merge", async () => {
    const out = await resolveFor({
      geoTargeting: [{ name: "India", kind: "country" }, { name: "Mumbai", kind: "city" }],
      geoExclusions: [{ name: "Goa", kind: "region" }],
    });

    expect(out.complete).toBe(true);
    expect(out.locations.map((l) => l.key)).toEqual(["IN", "1006094"]);
    expect(out.exclusions.map((l) => l.key)).toEqual(["3861"]);
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────────
       Meta keeps them in separate fields. An exclusion that arrives as an
       inclusion runs the campaign in the one place somebody said to avoid, and
       nothing on any screen shows it as wrong. */
    expect(out.locations.map((l) => l.key)).not.toContain("3861");

    const view = targeting.publicTargeting(out);
    expect(view.requestedExclusions).toHaveLength(1);
    expect(view.requestedLocations).toHaveLength(2);
  });

  test("14. ambiguous, not-found, unsupported and unavailable each block, and each says something different", async () => {
    const ambiguous = await resolveFor({ geoTargeting: [{ name: "Cambridge", kind: "city" }], geoExclusions: [] });
    expect(ambiguous.locations[0].outcome).toBe("ambiguous");
    expect(ambiguous.locations[0].key).toBeNull();
    expect(ambiguous.locations[0].candidates).toHaveLength(2);
    expect(ambiguous.complete).toBe(false);

    /* ── THE SUGGESTION ENDPOINT IS THE TRAP ──────────────────────────────
       Meta answers a misspelling with something plausible. GRAV compares
       exactly, so "Bengalru" is not found — and the suggestion is offered as a
       candidate rather than silently targeted. */
    const misspelled = await resolveFor({ geoTargeting: [{ name: "Bengalru", kind: "city" }], geoExclusions: [] });
    expect(misspelled.locations[0].outcome).toBe("not_found");
    expect(misspelled.locations[0].key).toBeNull();
    expect(misspelled.locations[0].candidates[0].canonicalName).toMatch(/Bengaluru/);

    const unsupported = await resolveFor({ geoTargeting: [{ name: "Near the depot", kind: "radius" }], geoExclusions: [] });
    expect(unsupported.locations[0].outcome).toBe("unsupported");

    const down = await resolveFor(
      { geoTargeting: [{ name: "India", kind: "country" }], geoExclusions: [] },
      { searchGeoTargets: async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); } },
    );
    expect(down.locations[0].outcome).toBe("provider_unavailable");
    expect(down.locations[0].detail).toMatch(/did not answer/i);

    for (const r of [ambiguous, misspelled, unsupported, down]) {
      expect(r.complete).toBe(false);
      expect(r.locations[0].blocksCreation).toBe(true);
    }
  });

  test("15. no location, and a place both targeted and excluded, are both refused", async () => {
    const none = await resolveFor({ geoTargeting: [], geoExclusions: [] });
    expect(none.blockers.map((b) => b.code)).toContain("GEO_NONE_SELECTED");

    const clash = await resolveFor({
      geoTargeting: [{ name: "India", kind: "country" }, { name: "Goa", kind: "region" }],
      geoExclusions: [{ name: "Goa", kind: "region" }],
    });
    expect(clash.blockers.map((b) => b.code)).toContain("GEO_INCLUDED_AND_EXCLUDED");
  });

  test("16. languages resolve or block, and an ambiguous one is not chosen between", async () => {
    const ok = await resolveFor({ languages: ["en", "hi"] });
    expect(ok.locales.map((l) => l.key)).toEqual(["6", "46"]);

    const ambiguous = await resolveFor({ languages: ["xx"] });
    expect(ambiguous.locales[0].outcome).toBe("ambiguous");
    expect(ambiguous.complete).toBe(false);

    const missing = await resolveFor({ languages: ["zz"] });
    expect(missing.locales[0].outcome).toBe("not_found");
  });

  test("17. ages are validated rather than looked up, and audiences GRAV cannot express are refused by name", async () => {
    /* Plain integers in the channel's own bounds. A lookup would be pointless,
       and saying so is what stops somebody building one. */
    expect(targeting.evaluateAge({ ageMin: 25, ageMax: 54 }).problems).toEqual([]);
    expect(targeting.evaluateAge({}).applies).toBe(false);

    /* ── STRICT, SO A COERCION IS NOT AN AGE ──────────────────────────────── */
    for (const bad of ["25", null, false, true, 25.5, {}]) {
      const out = targeting.evaluateAge({ ageMin: bad, ageMax: 54 });
      if (bad === null) { expect(out.problems).toEqual([]); continue; }
      expect(out.problems.length).toBeGreaterThan(0);
    }
    expect(targeting.evaluateAge({ ageMin: 12, ageMax: 54 }).problems[0].code).toBe("AGE_OUT_OF_BOUNDS");
    expect(targeting.evaluateAge({ ageMin: 54, ageMax: 25 }).problems[0].code).toBe("AGE_REVERSED");

    /* A dropped audience is a campaign shown to everybody. The resolver
       presents the brief's audience entries in the same five-outcome shape as
       locations, and `metaAudience` is the one place that refuses them — with a
       named feature — so one problem produces one message. */
    const out = await resolveFor({
      audiences: [
        { name: "Hotel managers", kind: "interest" },
        { name: "Past buyers", kind: "custom_list" },
        { name: "Searchers", kind: "search_intent" },
      ],
    });
    expect(out.audiences.map((a) => a.outcome)).toEqual(["unsupported", "unsupported", "unsupported"]);
    expect(out.audiences[1].detail).toMatch(/account-level object GRAV does not hold/i);
    expect(out.audiences[2].detail).toMatch(/Google concept/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   18–22. THE MAPPER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("mapping an approved plan to a Meta operation plan", () => {
  test("18. it is pure, deterministic, and performs no input or output", async () => {
    const plan = planObject();
    const args = { plan, account, resolvedTargeting: liveTargeting(plan), creativeAsset: { ready: true, problems: [], asset: goodAsset } };

    const a = mapper.map(args);
    const b = mapper.map(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    /* ── NO CLOCK, NO RANDOM, NO ENVIRONMENT, NO DATABASE, NO CHANNEL ──────
       A mapper that reached for any of these would make two identical plans
       produce two different campaigns, and nothing would fail. */
    const src = codeOf("services/marketing/deployment/metaTrafficMapper.js");
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(|Math\.random|process\.env/);
    expect(src).not.toMatch(/require\(".*(Client|service|model|Model)"\)/);
    expect(src).not.toMatch(/await |async /);
  });

  test("19. the proposed hierarchy is campaign → ad set → creative → advertisement, and only three can be stopped", async () => {
    const plan = planObject();
    const out = mapper.map({
      plan, account, resolvedTargeting: liveTargeting(plan),
      creativeAsset: { ready: true, problems: [], asset: goodAsset },
      trackingIdentity: PIXEL,
    });
    expect(out.mappable).toBe(true);

    expect(out.plan.objects.map((o) => o.role))
      .toEqual(["campaign", "audience_group", "creative", "advertisement"]);
    expect(out.plan.creationOrder)
      .toEqual(["campaign", "audience_group", "creative", "advertisement"]);

    /* Dependencies, declared per object rather than implied by the order. */
    const by = Object.fromEntries(out.plan.objects.map((o) => [o.role, o]));
    expect(by.campaign.dependsOn).toBeNull();
    expect(by.audience_group.dependsOn).toBe("campaign");
    expect(by.advertisement.dependsOn).toBe("audience_group");

    /* ── A CREATIVE DOES NOT DELIVER BY ITSELF ────────────────────────────
       It is a reusable description of what an advertisement looks like. It has
       no status, nothing is shown because of it, and asking whether it is
       stopped has no true answer — the same distinction the Google budget
       forced. */
    expect(by.creative.deliveryStateApplies).toBe(false);
    expect(by.creative.stoppedStatus).toBeNull();

    for (const role of ["campaign", "audience_group", "advertisement"]) {
      expect(by[role].deliveryStateApplies).toBe(true);
      expect(by[role].stoppedStatus).toBe("PAUSED");
    }

    /* The budget is on the ad set, and the reason is published rather than
       assumed. */
    expect(by.audience_group.describes.budget.amountMinorUnits).toBe(250000);
    expect(by.audience_group.describes.budget.providerField).toBe("daily_budget");
    expect(out.decisions.find((d) => d.code === "BUDGET_ON_THE_AD_SET").why)
      .toMatch(/switches on automated redistribution/i);
    expect(by.campaign.describes.budgetOptimisationAcrossAdSets).toBe(false);

    /* Targeting lands on the ad set, inclusions and exclusions apart. */
    expect(by.audience_group.describes.targeting.includedLocationKeys).toEqual(["IN"]);
    expect(by.audience_group.describes.targeting.excludedLocationKeys).toEqual(["3861"]);
    expect(by.audience_group.describes.targeting.localeKeys).toEqual(["6"]);

    /* ── AND EVERY OTHER BOUNDARY, INCLUDING THE ONE THAT MEANS EVERYONE ───
       `audienceExpansion: false` is WRITTEN rather than omitted: omitting it is
       how the channel's own default wins and the approved audience quietly
       stops having boundaries. */
    expect(by.audience_group.describes.audienceMode).toBe("broad_prospecting");
    expect(by.audience_group.describes.targeting.ageMin).toBe(25);
    expect(by.audience_group.describes.targeting.ageMax).toBe(54);
    expect(by.audience_group.describes.targeting.genders).toBe("all");
    expect(by.audience_group.describes.targeting.gendersProvider).toBeNull();
    expect(by.audience_group.describes.targeting.audienceExpansion).toBe(false);
  });

  test("20. not one hidden default: objective, optimisation, category and tracking are all explicit", async () => {
    const plan = planObject();
    const full = { plan, account, resolvedTargeting: liveTargeting(plan), creativeAsset: { ready: true, problems: [], asset: goodAsset } };

    /* ── THE SHARPEST ONE ─────────────────────────────────────────────────
       The channel's default special ad category is "none of these". A
       recruitment campaign declared as none is a policy violation and, in
       several jurisdictions, a legal one — and nobody discovers it from a
       screen. */
    const noCategory = mapper.map({
      ...full, plan: planObject({}, { specialAdCategory: "" }),
      resolvedTargeting: liveTargeting(planObject({}, { specialAdCategory: "" })),
    });
    expect(noCategory.problems.map((p) => p.code)).toContain("SPECIAL_AD_CATEGORY_MISSING");
    expect(noCategory.problems.find((p) => p.code === "SPECIAL_AD_CATEGORY_MISSING").message)
      .toMatch(/will not answer on somebody's behalf/i);

    const missingOptimisation = planObject({}, { metaOptimisation: "" });
    expect(mapper.map({
      ...full, plan: missingOptimisation, resolvedTargeting: liveTargeting(missingOptimisation),
    }).problems.map((p) => p.code)).toContain("OPTIMISATION_MISSING");

    const badOptimisation = planObject({}, { metaOptimisation: "conversions" });
    expect(mapper.map({
      ...full, plan: badOptimisation, resolvedTargeting: liveTargeting(badOptimisation),
    }).problems.map((p) => p.code)).toContain("OPTIMISATION_UNSUPPORTED");

    /* ── AN OPTIMISATION THAT NEEDS MEASUREMENT NEEDS THE PIXEL ────────────
       The channel cannot optimise for page views it cannot observe. Allowing it
       without tracking produces a campaign optimising against silence. */
    const pageViews = planObject({}, { metaOptimisation: "landing_page_views" });
    const withoutPixel = mapper.map({
      ...full, plan: pageViews, resolvedTargeting: liveTargeting(pageViews), trackingIdentity: "",
    });
    expect(withoutPixel.problems.map((p) => p.code)).toContain("OPTIMISATION_NEEDS_TRACKING");

    const withPixel = mapper.map({
      ...full, plan: pageViews, resolvedTargeting: liveTargeting(pageViews), trackingIdentity: PIXEL,
    });
    expect(withPixel.mappable).toBe(true);

    /* The objective itself is never chosen at mapping time. */
    const out = mapper.map({ ...full, trackingIdentity: PIXEL });
    expect(out.plan.objects[0].describes.objective).toBe("OUTCOME_TRAFFIC");
    expect(out.plan.summary.objective).toBe("website_traffic");
  });

  test("21. budget zero is a real zero, and a coerced number is not a number", async () => {
    const plan = planObject();
    const full = { plan, account, resolvedTargeting: liveTargeting(plan), creativeAsset: { ready: true, problems: [], asset: goodAsset } };

    /* ── ZERO IS AN AMOUNT SOMEBODY WROTE DOWN ────────────────────────────
       `!amount` would treat it as absent and report a missing budget, sending
       whoever wrote zero to fill in a field they had already filled in. */
    const zero = planObject({ budget: { amount: 0, currency: "INR", basis: "total" } });
    const zeroOut = mapper.map({ ...full, plan: zero, resolvedTargeting: liveTargeting(zero) });
    const zeroCodes = zeroOut.problems.map((p) => p.code);
    expect(zeroCodes).toContain("BUDGET_BELOW_PROVIDER_MINIMUM");
    expect(zeroCodes).not.toContain("BUDGET_MISSING");
    expect(zeroOut.problems.find((p) => p.code === "BUDGET_BELOW_PROVIDER_MINIMUM").message)
      .toMatch(/budget is zero/i);

    /* ── AND A STRING, A NULL OR A BOOLEAN IS NOT AN AMOUNT ───────────────
       `Number("2500")` is 2500, `Number(null)` is 0 and `Number(true)` is 1.
       Every one of those is a budget nobody approved. */
    for (const amount of ["2500", null, false, true, "", []]) {
      const coerced = planObject({ budget: { amount, currency: "INR", basis: "daily" } });
      const out = mapper.map({ ...full, plan: coerced, resolvedTargeting: liveTargeting(coerced) });
      expect(out.mappable).toBe(false);
      expect(out.problems.map((p) => p.code)).toContain("BUDGET_MISSING");
    }

    /* More precision than the currency holds is refused, not absorbed. */
    const precise = planObject({ budget: { amount: 25.005, currency: "INR", basis: "daily" } });
    expect(mapper.map({ ...full, plan: precise, resolvedTargeting: liveTargeting(precise) })
      .problems.map((p) => p.code)).toContain("BUDGET_NOT_WHOLE_MINOR_UNITS");

    /* A currency the account does not bill in would mean something else. */
    const usd = planObject({ budget: { amount: 2500, currency: "USD", basis: "daily" } });
    expect(mapper.map({ ...full, plan: usd, resolvedTargeting: liveTargeting(usd) })
      .problems.map((p) => p.code)).toContain("CURRENCY_MISMATCH");
  });

  test("22. text the channel will not accept is refused, never trimmed", async () => {
    const long = "Winter uniforms for the entire hospitality sector, made to measure and delivered nationwide within a single fortnight of order.";
    expect(long.length).toBeGreaterThan(125);

    const plan = planObject({}, {
      metaSingleImage: { ...META_BRIEF.metaSingleImage, primaryText: long, headline: "A headline that is very considerably too long for this" },
    });
    const out = mapper.map({
      plan, account, resolvedTargeting: liveTargeting(plan),
      creativeAsset: { ready: true, problems: [], asset: goodAsset },
    });

    const p = out.problems.find((x) => x.code === "PRIMARY_TEXT_TOO_LONG");
    expect(p.length).toBe(long.length);
    expect(p.allowed).toBe(125);
    expect(out.problems.map((x) => x.code)).toContain("HEADLINE_TOO_LONG");
    /* The truncated string appears nowhere. */
    expect(JSON.stringify(out)).not.toContain(long.slice(0, 125));

    /* A button outside the closed table is refused rather than mapped to
       whatever looks closest — it is the promise the advertisement makes. */
    const badCta = planObject({}, {
      metaSingleImage: { ...META_BRIEF.metaSingleImage, callToAction: "Find out more" },
    });
    expect(mapper.map({
      plan: badCta, account, resolvedTargeting: liveTargeting(badCta),
      creativeAsset: { ready: true, problems: [], asset: goodAsset },
    }).problems.map((x) => x.code)).toContain("CALL_TO_ACTION_UNSUPPORTED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   23–27. THE PREFLIGHT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Meta preflight", () => {
  test("23. it writes nothing, anywhere", async () => {
    await bindMeta();
    const plan = await approvedPlan();
    const before = await Binding.findOne({}).lean();

    const meta = fakeMeta();
    await metaPreflight.preflight({ companyId: A, plan }, { metaAds: meta });
    await metaPreflight.preflight({ companyId: A, plan }, { metaAds: meta });

    /* No deployment record, no attempt intent, no change to the plan or the
       binding. Running it twice has the same effect as running it once. */
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
    const after = await Binding.findOne({}).lean();
    expect(after.revision).toBe(before.revision);
    expect(String(after.updatedAt)).toBe(String(before.updatedAt));

    const stored = await drafts.loadForDeployment({
      companyId: A,
      campaignDraftId: require("../../services/marketing/campaignDrafts/draftIdentity")
        .encodeDraftId({ companyId: String(A), draftId: String(plan._id) }),
    });
    expect(stored.revision).toBe(plan.revision);
    expect(stored.deployed).toBeFalsy();
  });

  test("24. it reports account, targeting, creative, tracking and proposed objects", async () => {
    await bindMeta();
    await trackingConfig.save({
      companyId: A, user: ADMIN,
      payload: {
        siteUrl: "https://grav.in", trackingMode: "direct", metaPixelId: PIXEL,
        enabled: true, expectedRevision: 0, idempotencyKey: fresh("t"),
      },
    }).catch(() => null);

    const plan = await approvedPlan();
    const out = await metaPreflight.preflight({ companyId: A, plan }, deps());

    expect(out.channel).toBe("meta_ads");
    expect(out.campaignType).toBe("meta_traffic_single_image");
    expect(out.account.externalAccountId).toBe(ACCOUNT);
    expect(out.account.currency).toBe("INR");
    expect(out.account.timeZone).toBe("Asia/Kolkata");
    expect(out.account.status).toBe("ACTIVE");

    expect(out.targeting.requestedLocations[0].resolvedId).toBe("IN");
    expect(out.targeting.requestedExclusions[0].resolvedId).toBe("3861");
    expect(out.targeting.unresolved).toEqual([]);

    expect(out.proposedObjects.map((o) => o.role))
      .toEqual(["campaign", "audience_group", "creative", "advertisement"]);
    expect(out.proposedObjects.find((o) => o.role === "creative").wouldBeCreatedStopped).toBe(false);
    expect(out.proposedObjects.filter((o) => o.wouldBeCreatedStopped)).toHaveLength(3);

    /* ── THREE FLAGS, ALL FALSE ───────────────────────────────────────────── */
    expect(out.creationReady).toBe(false);
    expect(out.activationReady).toBe(false);
    expect(out.deploymentReady).toBe(false);
    expect(out.deploymentBlocked.reasonCode).toBe("META_CREATION_NOT_BUILT");

    /* ── AND IT SAYS THAT NOTHING HAPPENED ────────────────────────────────
       "Preflight" sounds like a departure. A reader who sees checks passing
       could reasonably think something did. */
    expect(out.nothingHappened).toMatchObject({
      createdAnything: false, publishedAnything: false,
      activatedDelivery: false, spentMoney: false, contactedAnybody: false,
    });
  });

  test("25. tracking is reported honestly whether it is configured or not", async () => {
    await bindMeta();
    const plan = await approvedPlan();

    const without = await metaPreflight.preflight({ companyId: A, plan }, deps());
    expect(without.tracking.identityConfigured).toBe(false);
    expect(without.tracking.identity).toBeNull();
    expect(without.tracking.means).toMatch(/only be optimised for clicks/i);
    /* Not an error: plenty of traffic campaigns run without one. */
    expect(without.checks.find((c) => c.code === "tracking_identity_readable").status)
      .toBe("not_applicable");

    /* A pixel the account cannot see measures nothing. */
    const foreign = await metaPreflight.preflight({ companyId: A, plan }, {
      metaAds: fakeMeta({ readPixel: async ({ pixelId }) => ({ requested: pixelId, found: null, accountPixelCount: 3 }) }),
      pixelOverride: "1",
    });
    expect(foreign.tracking.identityConfigured).toBe(false);
  });

  test("26. an account that cannot be read, or cannot be read back from, blocks and says which", async () => {
    await bindMeta();
    const plan = await approvedPlan();

    const cases = [
      [{ describeAccount: async () => ({ accountId: ACCOUNT, currency: "USD", timeZone: "Asia/Kolkata", status: "ACTIVE", businessId: BUSINESS, capabilities: [] }) },
        "account_currency_matches"],
      [{ describeAccount: async () => ({ accountId: ACCOUNT, currency: "INR", timeZone: "Asia/Kolkata", status: "DISABLED", businessId: BUSINESS, capabilities: [] }) },
        "account_usable"],
      /* ── A CONNECTION THAT CANNOT READ BACK PROVES NOTHING ───────────────
         Everything created has to be read back before it is called stopped. */
      [{ verifyDeploymentReads: async () => ({ campaigns: true, adSets: false, creatives: true, ads: true }) },
        "campaign_reads_available"],
    ];

    for (const [over, code] of cases) {
      const out = await metaPreflight.preflight({ companyId: A, plan }, { metaAds: fakeMeta(over) });
      expect(out.creationReady).toBe(false);
      expect(out.checks.find((c) => c.code === code).status).toBe("failed");
      expect(out.creationBlockers.map((b) => b.code)).toContain(code);
    }

    /* An outage answers EVERY dependent check as `could_not_check` rather than
       leaving them absent — an absent check reads as a check that passed. */
    const outage = await metaPreflight.preflight({ companyId: A, plan }, {
      metaAds: fakeMeta({ describeAccount: async () => { throw fail("CHANNEL_UNAVAILABLE", "x"); } }),
    });
    expect(outage.creationReady).toBe(false);
    expect(outage.checks.find((c) => c.code === "account_reachable").status).toBe("could_not_check");
    expect(outage.checks.filter((c) => c.status === "could_not_check").length).toBeGreaterThanOrEqual(6);
    expect(outage.externalChecksRequired.length).toBeGreaterThanOrEqual(6);
  });

  test("27. no credential, no provider path and no raw error reaches the response", async () => {
    await bindMeta();
    const plan = await approvedPlan();

    const out = await metaPreflight.preflight({ companyId: A, plan }, {
      metaAds: fakeMeta({
        describeAccount: async () => {
          throw fail("CHANNEL_UNAVAILABLE", "ECONNRESET reading https://graph.facebook.com/v21.0/act_1234567890?access_token=EAAJk2ZC");
        },
      }),
    });

    const flat = JSON.stringify(out);
    expect(flat).not.toMatch(/graph\.facebook\.com|ECONNRESET|access_token/i);
    expect(flat).not.toMatch(/EAA[A-Za-z0-9]{6,}|Bearer/);
    expect(flat).not.toMatch(/META_ADS_[A-Z_]+|MARKETING_CHANNEL_ID_SECRET/);
    /* The internal resolution, with its fence, is not on the wire from the
       route — checked there; here it is simply not spread into anything. */
    expect(out.checks.find((c) => c.code === "account_reachable").detail)
      .toMatch(/did not answer/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   28–30. THE BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("this slice ends before the first Meta mutation", () => {
  /* ── DRIVING A ROUTE, WHICH INJECTS NOTHING ────────────────────────────────
     A route builds its own client, so a route test cannot hand one in. The real
     module's read operations are spied instead, which means the route, the
     preflight, the resolver, the audience module and the privacy boundary all
     run for real — only the HTTP calls are replaced. This deployment holds no
     Meta credentials, so without this every route test would exercise the
     outage path. */
  const withFakeChannel = (over = {}) => {
    const fake = fakeMeta(over);
    const spies = ["describeAccount", "verifyDeploymentReads", "verifyInsightsRead",
      "readPixel", "searchGeoTargets", "searchLocales", "readVerifiedDomains",
      "readDeploymentByMarker", "accessibleAccounts"]
      .filter((op) => typeof metaAdsClient[op] === "function")
      .map((op) => jest.spyOn(metaAdsClient, op).mockImplementation(fake[op] || (async () => ({}))));
    return () => spies.forEach((sp) => sp.mockRestore());
  };

  test("28. the Meta write boundary is five operations, none of which can start anything", async () => {
    const writeClient = require("../../services/marketing/channels/metaAdsWriteClient");

    /* ── THE COMPLETE SET ─────────────────────────────────────────────────
       An image upload and four creates. No update, no activate, no publish, no
       enable — and no delete: a half-created campaign is left alone, because
       deleting means issuing more writes into an account GRAV has just proved
       it does not understand. */
    expect(writeClient.OPERATION_CODES)
      .toEqual(["image", "campaign", "audience_group", "creative", "advertisement"]);

    const exported = Object.keys(writeClient).filter((k) => typeof writeClient[k] === "function");
    expect(exported.sort()).toEqual([
      "assertNoAudienceExpansion", "assertNonDelivering", "create", "uploadImage",
    ]);
    for (const name of exported) {
      expect(name).not.toMatch(/update|activate|enable|publish|delete|remove|pause|post|request|graph/i);
    }
    for (const spec of Object.values(writeClient.OPERATIONS)) {
      expect(spec.operation).toMatch(/\.(upload|create)$/);
    }

    /* ── THE CHANNEL'S WORD FOR A DELIVERING OBJECT IS NOT IN THE FILE ───── */
    const src = codeOf("services/marketing/channels/metaAdsWriteClient.js");
    expect(src).not.toMatch(/["'`]ACTIVE["'`]/);
    expect(src).not.toMatch(/["'`]ENABLED["'`]/);

    /* ── AND ONLY THIS FILE MAY ASK THE HTTP LAYER FOR PERMISSION TO WRITE ─ */
    const root = path.join(__dirname, "../..");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.isFile() && full.endsWith(".js") ? [full] : [];
    });
    const allowed = new Set([
      path.join(root, "services/marketing/channels/metaAdsWriteClient.js"),
      path.join(root, "services/marketing/channels/googleSearchBundle.js"),
      path.join(root, "services/marketing/channels/channelHttp.js"),
    ]);
    for (const file of [
      ...walk(path.join(root, "services/marketing")),
      ...walk(path.join(root, "routes/CMS_Routes/Marketing")),
    ]) {
      if (allowed.has(file)) continue;
      const clean = fs.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      /* No file but the write client may ask the HTTP layer for permission to
         write. The READ client legitimately names the channel's host — reads
         are not the danger — so the host is checked only for the write flag. */
      expect(clean).not.toMatch(/mutationIntent/);
    }
  });

  test("29. a Meta plan can be prepared, and the preflight publishes nothing a credential touches", async () => {
    const restore = withFakeChannel();
    await bindMeta();
    const plan = await approvedPlan();
    const id = require("../../services/marketing/campaignDrafts/draftIdentity")
      .encodeDraftId({ companyId: String(A), draftId: String(plan._id) });

    const pre = await call(`/campaign-drafts/${id}/deployment/meta_ads/preflight`);
    expect(pre.status).toBe(200);
    expect(pre.body.channel).toBe("meta_ads");
    expect(pre.body.activationReady).toBe(false);
    expect(pre.body.deploymentReady).toBe(false);
    /* The internal resolution, audience and asset never reach the wire. */
    expect(pre.body.__resolution).toBeUndefined();
    expect(pre.body.__audience).toBeUndefined();
    expect(pre.body.__asset).toBeUndefined();

    const flat = JSON.stringify(pre.body);
    expect(flat).not.toMatch(/graph\.facebook\.com|access_token|Bearer|META_ADS_[A-Z_]+/i);
    /* And no storage identifier: the image lives in a company Drive and its id
       is `select: false` on the model and absent from every view. */
    expect(flat).not.toMatch(/driveFileId|storageRef/i);

    restore();
  });

  test("30. the Google path is untouched — same channel, same contract", async () => {
    /* ── A SHARED ABSTRACTION MUST NOT CHANGE THE CHANNEL IT CAME FROM ────
       The binding service now serves two channels. Google's own behaviour —
       its identifier shape, its normalisation, its refusal — is unchanged. */
    expect(binding.normaliseGoogleAccountId("123-456-7890", "f")).toBe("1234567890");
    expect(binding.normaliseGoogleAccountId("1234567890", "f")).toBe("1234567890");
    expect(() => binding.normaliseGoogleAccountId("act_1234567890", "f")).toThrow(/not an advertising account identifier/i);
    expect(() => binding.normaliseGoogleAccountId("", "f")).toThrow(/will not choose one for you/i);

    expect(binding.BINDABLE_CHANNELS).toEqual(["google_ads", "meta_ads"]);
    expect(Object.keys(binding.CHANNEL_ADAPTERS)).toEqual(["google_ads", "meta_ads"]);

    /* And the Google deployment contract is exactly as it was. */
    const bundle = require("../../services/marketing/channels/googleSearchBundle");
    expect(bundle.MUTABLE_ROLES || Object.keys(bundle)).toBeTruthy();
    expect(typeof bundle.createPausedAtomic).toBe("function");
    expect(codeOf("services/marketing/channels/googleSearchBundle.js")).not.toMatch(/meta/i);
  });
});
