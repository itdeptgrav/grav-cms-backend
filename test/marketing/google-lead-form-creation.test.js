// test/marketing/google-lead-form-creation.test.js
//
// A GOOGLE SEARCH CAMPAIGN WITH A LEAD FORM: DRAFTED, JUDGED, CREATED STOPPED —
// AND ONLY IN THE PROOF ACCOUNT.
//
// Nothing here reaches Google. The fake channel answers exactly as v25 does for
// the requests GRAV sends, and records every envelope, so the assertions are
// about the bytes that would have gone out:
//
//   - the intent is written before any external write;
//   - one validate-only pass, then ONE atomic mutate, every status PAUSED;
//   - the form and its link read back stopped before success is claimed;
//   - an unknown outcome is never retried, and closes only by reconciliation;
//   - the webhook secret is sent once and stored, logged and returned nowhere;
//   - the capability stays blocked, whatever these tests prove.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

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
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent, MarketingCampaignDeploymentAttemptResult,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const { MarketingLeadDeliveryBinding } = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");

const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const binding = require("../../services/marketing/deployment/accountBinding.service");
const leadPreflight = require("../../services/marketing/deployment/googleLeadFormPreflight.service");
const leadCreation = require("../../services/marketing/deployment/leadFormPausedCreation.service");
const bundleClient = require("../../services/marketing/channels/googleSearchBundle");
const webhookKey = require("../../services/marketing/leads/leadWebhookKey");
const leadBindings = require("../../services/marketing/leads/leadDeliveryBinding.service");
const caps = require("../../constants/marketingCampaignCapabilities");
const readiness = require("../../constants/marketingDeploymentReadiness");
const G = require("../../constants/marketingGoogleLeadForm");
const { fail } = require("../../services/storePurchase/errors");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const ACCOUNT = "1234567890";
const PUBLIC = "https://api.grav.example";
const MASTER = crypto.randomBytes(32).toString("hex");

const ENV_KEYS = [
  "MARKETING_CHANNEL_ID_SECRET", "MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1",
  "API_PUBLIC_URL", G.CONTROLLED_ACCOUNT_VAR,
];
const saved = {};
let A;
let server;
let base;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDeployment"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignCapabilities"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  Object.assign(process.env, {
    MARKETING_CHANNEL_ID_SECRET: "a-deployment-secret-long-enough",
    MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1: MASTER,
    API_PUBLIC_URL: PUBLIC,
    [G.CONTROLLED_ACCOUNT_VAR]: ACCOUNT,
  });
});

/* ═══ THE PLAN ════════════════════════════════════════════════════════════ */

const LEAD_FORM = Object.freeze({
  businessName: "GRAV Clothing",
  headline: "Request a uniform quote",
  description: "Tell us what your team needs and we will price it.",
  callToAction: "GET_QUOTE",
  callToActionDescription: "A written quote within two working days.",
  privacyPolicyUrl: "https://grav.in/privacy",
  postSubmitHeadline: "Thank you",
  postSubmitCallToAction: "VISIT_SITE",
  fields: ["FULL_NAME", "EMAIL", "PHONE_NUMBER"],
  qualifyingQuestions: ["COMPANY_SIZE"],
});

const BRIEF = Object.freeze({
  channel: "google_ads",
  campaignType: "google_lead_form",
  destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
  geoTargeting: [{ name: "India", kind: "country" }],
  geoExclusions: [{ name: "Goa", kind: "region" }],
  languages: ["en"],
  audiences: [],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "target_cost_per_action", target: { amount: 450, currency: "INR" } },
  budgetRelationship: "campaign_daily",
  euPoliticalAdvertising: "does_not_contain",
  googleSearch: {
    headlines: ["Winter uniforms", "Hotel uniforms", "Bulk orders"],
    descriptions: ["Made to measure for hospitality.", "Delivered across India."],
    keywordThemes: ["hotel uniforms", "hospital uniforms"],
  },
  googleLeadForm: LEAD_FORM,
  timezone: "Asia/Kolkata",
});

const PLAN = Object.freeze({
  name: "Winter lead forms",
  objective: "lead_generation",
  channels: ["google_ads"],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 2500,
  budgetCurrency: "INR",
  budgetBasis: "daily",
  conversionGoal: "form_submission",
});

async function draftPlan(briefOver = {}) {
  return drafts.create({
    companyId: A, user: MARKETER,
    payload: { ...PLAN, utmCampaign: fresh("lf"), idempotencyKey: fresh("create-key-000"), deploymentBriefs: [{ ...BRIEF, ...briefOver }] },
  });
}

async function approvedPlan(briefOver = {}) {
  const created = await draftPlan(briefOver);
  await drafts.submit({ companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision });
  await drafts.decide({ companyId: A, user: ADMIN, campaignDraftId: created.campaignDraftId, decision: "approve" });
  return drafts.loadForDeployment({ companyId: A, campaignDraftId: created.campaignDraftId });
}

/* ═══ THE FAKE CHANNEL ════════════════════════════════════════════════════ */

const RESULT_KEY = Object.freeze({
  labelOperation: "labelResult", campaignBudgetOperation: "campaignBudgetResult",
  campaignOperation: "campaignResult", campaignLabelOperation: "campaignLabelResult",
  adGroupOperation: "adGroupResult", adGroupAdOperation: "adGroupAdResult",
  adGroupCriterionOperation: "adGroupCriterionResult", campaignCriterionOperation: "campaignCriterionResult",
  assetOperation: "assetResult", campaignAssetOperation: "campaignAssetResult",
});
const RESOURCE_OF = Object.freeze({
  labelOperation: "labels", campaignBudgetOperation: "campaignBudgets", campaignOperation: "campaigns",
  campaignLabelOperation: "campaignLabels", adGroupOperation: "adGroups", adGroupAdOperation: "adGroupAds",
  adGroupCriterionOperation: "adGroupCriteria", campaignCriterionOperation: "campaignCriteria",
  assetOperation: "assets", campaignAssetOperation: "campaignAssets",
});

function fakeTransport(plan = {}) {
  let next = 5000;
  const t = async ({ operation, url, headers, data }) => {
    t.calls.push({ operation, url, headers, data });
    if (t.onCall) await t.onCall({ operation, data });
    const step = plan[data.validateOnly === true ? "validate" : "create"];
    if (typeof step === "function") return step({ operation, url, data });
    const account = url.match(/customers\/(\d+)\//)[1];
    if (data.validateOnly === true) return { status: 200, data: {} };
    const responses = data.mutateOperations.map((op) => {
      const key = Object.keys(op)[0];
      next += 1;
      t.created.push({ key, providerObjectId: String(next), payload: op[key].create });
      return { [RESULT_KEY[key]]: { resourceName: `customers/${account}/${RESOURCE_OF[key]}/${next}` } };
    });
    return { status: 200, data: { mutateOperationResponses: responses } };
  };
  t.calls = [];
  t.created = [];
  return t;
}

const GEO = {
  India: [{ criterionId: "2356", resourceName: "geoTargetConstants/2356", name: "India", canonicalName: "India", countryCode: "IN", targetType: "Country", status: "ENABLED" }],
  Goa: [{ criterionId: "20981", resourceName: "geoTargetConstants/20981", name: "Goa", canonicalName: "Goa,India", countryCode: "IN", targetType: "State", status: "ENABLED" }],
};
const LANG = { en: [{ criterionId: "1000", resourceName: "languageConstants/1000", code: "en", name: "English", targetable: true }] };

/* What the account holds, derived from what the transport recorded. */
function fakeRead(transport, over = {}) {
  const made = (key) => transport.created.filter((c) => c.key === key);
  const bundle = () => {
    const campaign = made("campaignOperation")[0];
    if (!campaign) return { labels: [], campaigns: [] };
    return {
      labels: [{ labelId: "L1", name: "m", resourceName: "customers/x/labels/1", status: "ENABLED" }],
      campaigns: [{
        campaignId: campaign.providerObjectId, name: campaign.payload.name, status: "PAUSED", channelType: "SEARCH",
        labelResourceName: "customers/x/labels/1",
        budgets: made("campaignBudgetOperation").map((b) => ({ budgetId: b.providerObjectId, name: b.payload.name })),
        adGroups: made("adGroupOperation").map((g) => ({ adGroupId: g.providerObjectId, name: g.payload.name, status: "PAUSED" })),
        ads: made("adGroupAdOperation").map((a) => ({ adId: a.providerObjectId, status: "PAUSED", finalUrls: [] })),
        keywords: made("adGroupCriterionOperation").map((k) => ({ criterionId: k.providerObjectId, status: "PAUSED", text: k.payload.keyword.text })),
        criteria: made("campaignCriterionOperation").map((c) => ({
          criterionId: c.providerObjectId, negative: c.payload.negative === true,
          geoTargetConstant: c.payload.location?.geoTargetConstant || "",
          languageConstant: c.payload.language?.languageConstant || "",
        })),
      }],
    };
  };
  return {
    describeAccount: jest.fn(async ({ customerId }) => ({
      accountId: customerId, accountName: "GRAV Ads", currency: "INR", timeZone: "Asia/Kolkata",
      isManager: false, isTestAccount: true, status: "ENABLED",
    })),
    accessibleAccounts: jest.fn(async () => [ACCOUNT]),
    findCampaignsByName: jest.fn(async () => []),
    hasConversionAction: jest.fn(async () => over.noConversion !== true),
    findGeoTargets: jest.fn(async ({ name, targetTypes }) => (GEO[name] || []).filter((c) => !targetTypes?.length || targetTypes.includes(c.targetType))),
    findLanguages: jest.fn(async ({ code }) => LANG[code] || []),
    readCampaignCriteria: jest.fn(async () => []),
    readBundleByMarker: jest.fn(async ({ marker }) => {
      if (over.bundleUnavailable) throw fail("CHANNEL_UNAVAILABLE", "no answer");
      return { marker, ...bundle() };
    }),
    readLeadFormLink: jest.fn(async () => {
      if (over.linkUnavailable) throw fail("CHANNEL_UNAVAILABLE", "no answer");
      const asset = made("assetOperation")[0];
      const link = made("campaignAssetOperation")[0];
      if (!asset || !link || over.dropLink) return [];
      const urls = asset.payload.leadFormAsset.deliveryMethods.map((m) => m.webhook.advertiserWebhookUrl);
      return [{
        linkStatus: over.linkStatus || link.payload.status,
        fieldType: link.payload.fieldType,
        assetId: asset.providerObjectId,
        assetType: "LEAD_FORM",
        webhookUrls: over.noUrlEcho ? [] : over.wrongUrl ? ["https://elsewhere.example/hook"] : urls,
      }];
    }),
  };
}

const authorise = async () => ({ creds: { loginCustomerId: "" }, token: "t" });
const depsFor = (over = {}) => {
  const transport = over.transport || fakeTransport(over.transportPlan || {});
  return { transport, authorise, googleAds: over.googleAds || fakeRead(transport, over.read || {}) };
};

async function bindAccount() {
  const transport = fakeTransport();
  return binding.bind({ companyId: A, channel: "google_ads", payload: { externalAccountId: ACCOUNT }, actor: ADMIN }, { googleAds: fakeRead(transport) });
}

const create = (plan, deps, over = {}) => leadCreation.createPaused({
  companyId: A, plan, expectedRevision: plan.revision, idempotencyKey: over.key || "lead-create-0001",
  requestedBy: { id: ADMIN.id, name: ADMIN.name, role: ADMIN.role },
  authorizedBy: { id: ADMIN.id, name: ADMIN.name, at: new Date() },
  ...over.args,
}, deps);

const mutates = (t) => t.calls.filter((c) => c.data.validateOnly !== true);
const validations = (t) => t.calls.filter((c) => c.data.validateOnly === true);
const counts = async () => ({
  deployments: await MarketingCampaignDeployment.countDocuments({}),
  intents: await MarketingCampaignDeploymentAttemptIntent.countDocuments({}),
  results: await MarketingCampaignDeploymentAttemptResult.countDocuments({}),
  bindings: await MarketingLeadDeliveryBinding.countDocuments({}),
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE DRAFT CONTRACT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the lead form is stored on the draft", () => {
  test("1. a lead-form brief is written, read back exactly, and the type stays off the deployable list", async () => {
    const created = await draftPlan();
    const detail = await drafts.detail({ companyId: A, campaignDraftId: created.campaignDraftId, user: MARKETER });
    const brief = detail.draft.deploymentBriefs[0];
    expect(brief.campaignType).toBe("google_lead_form");
    expect(brief.googleLeadForm).toEqual({
      ...LEAD_FORM, postSubmitDescription: "",
    });
    expect(readiness.SUPPORTED_CAMPAIGN_TYPE_CODES).not.toContain("google_lead_form");
    expect(readiness.RECORDABLE_CAMPAIGN_TYPE_CODES).toContain("google_lead_form");
  });

  test("2. the edit path takes it under the revision fence, and refuses unknown or misplaced keys", async () => {
    const created = await draftPlan();
    const edited = await drafts.update({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId,
      payload: { expectedRevision: created.revision, deploymentBriefs: [{ ...BRIEF, googleLeadForm: { ...LEAD_FORM, headline: "Get a quote today" } }] },
    });
    expect(edited.deploymentBriefs[0].googleLeadForm.headline).toBe("Get a quote today");

    for (const bad of [
      { ...BRIEF, googleLeadForm: { ...LEAD_FORM, googleSecret: "x" } },
      { ...BRIEF, googleLeadForm: { ...LEAD_FORM, webhookUrl: "https://x" } },
      { ...BRIEF, googleLeadForm: { ...LEAD_FORM, marketingConsent: { requested: true } } },
      { ...BRIEF, campaignType: "google_search", googleLeadForm: LEAD_FORM },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(drafts.update({
        companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId,
        payload: { expectedRevision: edited.revision, deploymentBriefs: [bad] },
      })).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  test("3. readiness judges the form, and Submit refuses what readiness refuses", async () => {
    const created = await draftPlan({ bidding: { strategy: "maximise_clicks" }, googleLeadForm: { ...LEAD_FORM, privacyPolicyUrl: "" } });
    const view = await drafts.deploymentReadiness({ companyId: A, campaignDraftId: created.campaignDraftId });
    expect(view.approvalReady).toBe(false);
    const codes = [...view.sections.missingFromPlan, ...view.sections.contradictions].map((f) => `${f.code}:${f.field}`);
    expect(codes).toEqual(expect.arrayContaining([
      "LEAD_FORM_INCOMPLETE:googleLeadForm.privacy_policy_present",
      "LEAD_FORM_INCOMPLETE:bidding.strategy",
    ]));
    await expect(drafts.submit({ companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" });
  });

  test("4. a complete lead-form plan is submittable and approvable, and says it is created only in the proof account", async () => {
    const created = await draftPlan();
    const view = await drafts.deploymentReadiness({ companyId: A, campaignDraftId: created.campaignDraftId });
    expect(view.approvalReady).toBe(true);
    expect(view.deploymentReady).toBe(false);
    const note = view.sections.unsupportedByGrav.find((f) => f.code === "LEAD_FORM_CONTROLLED_ONLY");
    expect(note.severity).toBe("advisory");
    const plan = await approvedPlan();
    expect(plan.state).toBe("approved");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. PREFLIGHT — READS ONLY, AND HOLDS THE GATE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("preflight", () => {
  test("5. ready only in the proof account, with a public https address and a derivable key — and it writes nothing", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const before = await counts();
    const deps = depsFor();

    const ok = await leadPreflight.preflight({ companyId: A, plan }, deps);
    expect(ok.creationReady).toBe(true);
    expect(ok.campaignType).toBe("google_lead_form");
    expect(ok.activationReady).toBe(false);
    expect(ok.ifCreated).toMatchObject({ status: "PAUSED", formStatus: "PAUSED", spendsMoney: false, delivers: false });
    expect(ok.externalChecksRequired.map((c) => c.code)).toEqual(["lead_form_conversion_goal", "account_vertical_eligible", "real_lead_delivery"]);

    for (const [env, failing] of [
      [{ [G.CONTROLLED_ACCOUNT_VAR]: "" }, "lead_form_controlled_account"],
      [{ [G.CONTROLLED_ACCOUNT_VAR]: "9999999999" }, "lead_form_controlled_account"],
      [{ API_PUBLIC_URL: "" }, "lead_form_delivery_address"],
      [{ API_PUBLIC_URL: "http://api.grav.example" }, "lead_form_delivery_address"],
      [{ API_PUBLIC_URL: "https://localhost:5000" }, "lead_form_delivery_address"],
      [{ MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1: "" }, "lead_form_delivery_key"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await leadPreflight.preflight({ companyId: A, plan, env: { ...process.env, ...env } }, deps);
      expect({ failing, ready: out.creationReady }).toEqual({ failing, ready: false });
      expect(out.checks.find((c) => c.code === failing).status).toBe("failed");
    }

    expect(await counts()).toEqual(before);
    expect(deps.transport.calls).toHaveLength(0);
    const flat = JSON.stringify(ok, (k, v) => (k.startsWith("__") ? undefined : v));
    expect(flat).not.toContain(MASTER);
    expect(flat).not.toMatch(/gld1\./);
  });

  test("6. an account with nothing to measure conversions is refused, because a lead form bids towards them", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const out = await leadPreflight.preflight({ companyId: A, plan }, depsFor({ read: { noConversion: true } }));
    expect(out.creationReady).toBe(false);
    expect(out.checks.find((c) => c.code === "conversion_action_present")).toMatchObject({ status: "failed", blocksCreation: true });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. CREATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("creating the campaign and its form, stopped", () => {
  test("7. intent first, one validate, one atomic mutate, read back stopped — then the binding is bound", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor();
    let intentAtWrite = null;
    deps.transport.onCall = async ({ data }) => {
      if (data.validateOnly !== true) intentAtWrite = await MarketingCampaignDeploymentAttemptIntent.countDocuments({ companyId: A });
    };

    const out = await create(plan, deps);

    expect(out).toMatchObject({ created: true, outcome: "succeeded", leadFormStopped: true, deliveryBound: true, deliveryAddressConfirmed: true });
    expect(intentAtWrite).toBe(1);
    expect(validations(deps.transport)).toHaveLength(1);
    expect(mutates(deps.transport)).toHaveLength(1);

    /* The envelope: every status PAUSED, the form and its link present, create only. */
    const ops = mutates(deps.transport)[0].data.mutateOperations;
    expect(JSON.stringify(ops)).not.toMatch(/"status":"(ENABLED|ENABLE)"/);
    for (const op of ops) expect(Object.keys(op[Object.keys(op)[0]])).toEqual(["create"]);
    const asset = ops.find((op) => op.assetOperation).assetOperation.create;
    const link = ops.find((op) => op.campaignAssetOperation).campaignAssetOperation.create;
    expect(link).toMatchObject({ fieldType: "LEAD_FORM", status: "PAUSED" });
    expect(asset.leadFormAsset).toMatchObject({
      businessName: "GRAV Clothing", callToActionType: "GET_QUOTE",
      privacyPolicyUrl: "https://grav.in/privacy", postSubmitCallToActionType: "VISIT_SITE",
    });
    expect(asset.leadFormAsset.fields.map((f) => f.inputType)).toEqual(["FULL_NAME", "EMAIL", "PHONE_NUMBER", "COMPANY_SIZE"]);
    expect(asset.finalUrls[0]).toMatch(/^https:\/\/grav\.in\/uniforms\/winter/);
    const [delivery] = asset.leadFormAsset.deliveryMethods;
    expect(delivery.webhook.payloadSchemaVersion).toBe("3");
    expect(delivery.webhook.advertiserWebhookUrl.startsWith(`${PUBLIC}/api/cms/marketing/google-leads/gld1.`)).toBe(true);

    /* The secret sent is exactly the one GRAV derives for this binding. */
    const row = await MarketingLeadDeliveryBinding.findOne({ companyId: A }).select("+providerFormId +providerCampaignId");
    const identity = leadBindings.derivationIdentity(row);
    expect(webhookKey.verifyWebhookKey({ supplied: delivery.webhook.googleSecret, ...identity })).toBe(true);
    expect(row.state).toBe("bound");
    expect(row.providerFormId).toBe(out.providerLeadFormId);
    expect(row.providerCampaignId).toBe(out.providerCampaignId);

    /* The attempt: succeeded, both form objects, the link confirmed stopped. */
    const result = await MarketingCampaignDeploymentAttemptResult.findOne({ companyId: A }).lean();
    expect(result.outcome).toBe("succeeded");
    const roles = result.objects.map((o) => o.role);
    expect(roles).toEqual(expect.arrayContaining(["campaign", "lead_form", "lead_form_link"]));
    expect(result.objects.find((o) => o.role === "lead_form_link")).toMatchObject({ nonDeliveringConfirmed: true, observedState: "PAUSED" });
    expect(result.objects.find((o) => o.role === "lead_form").deliveryStateApplies).toBe(false);
    const deployment = await MarketingCampaignDeployment.findOne({ companyId: A }).lean();
    expect(deployment).toMatchObject({ state: "paused_confirmed", campaignType: "google_lead_form" });
  });

  test("8. the secret is sent once and stored, returned and logged nowhere", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor();
    const logged = [];
    const spies = ["log", "error", "warn"].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logged.push(a.join(" "))));
    const out = await create(plan, deps);
    spies.forEach((s) => s.mockRestore());

    const secret = mutates(deps.transport)[0].data.mutateOperations
      .find((op) => op.assetOperation).assetOperation.create.leadFormAsset.deliveryMethods[0].webhook.googleSecret;
    expect(secret.length).toBeGreaterThan(20);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(logged.join("\n")).not.toContain(secret);
    for (const name of Object.keys(mongoose.connection.collections)) {
      // eslint-disable-next-line no-await-in-loop
      const docs = await mongoose.connection.collections[name].find({}).toArray();
      expect({ name, leaked: JSON.stringify(docs).includes(secret) }).toEqual({ name, leaked: false });
    }
  });

  test("9. the approved revision must be named, and outside the proof account nothing is written anywhere", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor();
    const before = await counts();

    await expect(create(plan, deps, { args: { expectedRevision: undefined } })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
    await expect(create(plan, deps, { args: { expectedRevision: plan.revision - 1 } })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
    process.env[G.CONTROLLED_ACCOUNT_VAR] = "9999999999";
    await expect(create(plan, deps)).rejects.toMatchObject({ code: "CAMPAIGN_DEPLOYMENT_NOT_READY" });

    expect(await counts()).toEqual(before);
    expect(deps.transport.calls).toHaveLength(0);
  });

  test("10. a refusal creates nothing and claims nothing", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor({ transportPlan: { validate: async () => { throw fail("CHANNEL_MALFORMED_RESPONSE", "no"); } } });
    const out = await create(plan, deps);
    expect(out).toMatchObject({ created: false, outcome: "failed" });
    expect(mutates(deps.transport)).toHaveLength(0);
    const result = await MarketingCampaignDeploymentAttemptResult.findOne({ companyId: A }).lean();
    expect(result.objects).toEqual([]);
    expect((await MarketingLeadDeliveryBinding.findOne({ companyId: A })).state).toBe("prepared");
  });

  test("11. a lost response is never retried: the next creation is refused until reconciliation finds it", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const transport = fakeTransport();
    let lose = true;
    const real = transport;
    const lossy = async (req) => {
      const res = await real(req);
      if (req.data.validateOnly !== true && lose) { lose = false; throw fail("CHANNEL_UNAVAILABLE", "timeout"); }
      return res;
    };
    lossy.calls = real.calls;
    lossy.created = real.created;
    const deps = { transport: lossy, authorise, googleAds: fakeRead(real) };

    const first = await create(plan, deps);
    expect(first).toMatchObject({ outcome: "unknown", unresolved: true, requiresReconciliation: true });
    await expect(create(plan, deps)).rejects.toMatchObject({ code: "CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED" });
    expect(mutates(real)).toHaveLength(1);
    expect((await MarketingLeadDeliveryBinding.findOne({ companyId: A })).state).toBe("prepared");

    const rec = await leadCreation.reconcile({ companyId: A, plan }, deps);
    expect(rec).toMatchObject({ reconciled: true, leadForm: { outcome: "confirmed" }, deliveryBound: true });
    const result = await MarketingCampaignDeploymentAttemptResult.findOne({ companyId: A }).lean();
    expect(result.objects.every((o) => o.origin === "observed")).toBe(true);
    expect(mutates(real)).toHaveLength(1);
  });

  test("12. a form link that is not stopped, missing, or delivering elsewhere is never called a success", async () => {
    for (const read of [{ linkStatus: "ENABLED" }, { dropLink: true }, { wrongUrl: true }, { linkUnavailable: true }]) {
      // eslint-disable-next-line no-await-in-loop
      await MarketingCampaignDeployment.deleteMany({});
      // eslint-disable-next-line no-await-in-loop
      await bindAccount().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const plan = await approvedPlan();
      const deps = depsFor({ read });
      // eslint-disable-next-line no-await-in-loop
      const out = await create(plan, deps, { key: fresh("key-000000") });
      expect({ read, outcome: out.outcome, stopped: out.leadFormStopped }).toEqual({ read, outcome: "partially_created", stopped: false });
      // eslint-disable-next-line no-await-in-loop
      const row = await MarketingLeadDeliveryBinding.findOne({ companyId: A }).sort({ createdAt: -1 });
      expect(row.state).toBe("prepared");
    }
  });

  test("13. a read that does not echo the address still confirms 'stopped', and says the address is unconfirmed", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const out = await create(plan, depsFor({ read: { noUrlEcho: true } }));
    expect(out).toMatchObject({ outcome: "succeeded", leadFormStopped: true, deliveryAddressConfirmed: false });
  });

  test("14. an already-created revision is not created again", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor();
    await create(plan, deps);
    await expect(create(plan, deps)).rejects.toMatchObject({ code: "CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED" });
    expect(mutates(deps.transport)).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what this slice does not do", () => {
  test("15. the type stays blocked, whatever these tests prove", () => {
    const type = caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form;
    expect(type.deployable).toBe(false);
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).not.toContain("google_lead_form");
    expect(Object.values(G.UNVERIFIED).every((u) => u.verified === false)).toBe(true);
    expect(type.needs.join(" ")).toMatch(/proof account/);
    expect(type.needs.join(" ")).toMatch(/real enquiry/);
  });

  test("16. no activation, publishing, scheduling or update exists on the write path", () => {
    const fs = require("fs");
    const path = require("path");
    const code = (f) => fs.readFileSync(path.join(__dirname, "../..", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const f of [
      "services/marketing/channels/googleSearchBundle.js",
      "services/marketing/deployment/leadFormPausedCreation.service.js",
      "services/marketing/deployment/googleLeadFormMapper.js",
    ]) {
      const src = code(f);
      expect(src).not.toMatch(/\b(update|remove)\s*:/);
      expect(src).not.toMatch(/["']ENABLED["']/);
      expect(src).not.toMatch(/\b(activate|publish|schedule)\w*\s*\(/i);
    }
    expect(bundleClient.ALLOWED_OPERATION_KEYS).toEqual(expect.arrayContaining(["assetOperation", "campaignAssetOperation"]));
  });

  test("17. the route builds preflight field by field: no internals, no address, no secret", async () => {
    await bindAccount();
    const plan = await approvedPlan();
    const deps = depsFor();
    const spy = jest.spyOn(require("../../services/marketing/channels/googleAdsClient"), "describeAccount").mockImplementation(deps.googleAds.describeAccount);
    const mocks = ["findCampaignsByName", "hasConversionAction", "findGeoTargets", "findLanguages"]
      .map((m) => jest.spyOn(require("../../services/marketing/channels/googleAdsClient"), m).mockImplementation(deps.googleAds[m]));
    const id = drafts.present(plan, { companyId: A }).campaignDraftId;
    const res = await fetch(`${base}/campaign-drafts/${encodeURIComponent(id)}/deployment/google_ads/preflight`, {
      headers: { "x-test-user": JSON.stringify(ADMIN), "x-test-company": String(A) },
    });
    const body = await res.json();
    spy.mockRestore();
    mocks.forEach((m) => m.mockRestore());
    expect(res.status).toBe(200);
    expect(body.campaignType).toBe("google_lead_form");
    const flat = JSON.stringify(body);
    expect(flat).not.toMatch(/__resolution|__mapped|__deliveryBase|gld1\.|google-leads/);
    expect(flat).not.toContain(MASTER);
  });

  test("18. the builder gets the whole form vocabulary from the server, from the evaluator's own constants", () => {
    const v = drafts.vocabulary.googleLeadForm;
    expect(v.callToActionTypes.map((c) => c.code)).toEqual([...G.CALL_TO_ACTION_TYPES]);
    expect(v.callToActionTypes.map((c) => c.code)).toContain("GET_QUOTE");
    expect(v.postSubmitCallToActionTypes.map((c) => c.code)).toEqual(["DOWNLOAD", "LEARN_MORE", "SHOP_NOW", "VISIT_SITE"]);
    expect(v.qualifyingQuestions.find((q) => q.code === "COMPANY_SIZE").question).toBe("What size is your company?");
    expect(v.maxQualifyingQuestions).toBe(5);
    expect(v.contactableFields).toEqual(["EMAIL", "PHONE_NUMBER"]);
    expect(v.marketingConsentOffered).toBe(false);
    expect(v.contentFields.find((f) => f.code === "privacyPolicyUrl")).toMatchObject({ required: true });
  });

  test("19. the capability entry says what is built and what can be done today, and stays blocked", async () => {
    const res = await fetch(`${base}/campaign-capabilities/google_lead_form`, {
      headers: { "x-test-user": JSON.stringify(ADMIN), "x-test-company": String(A) },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    const view = body;
    expect(view.campaignType).toBe("google_lead_form");
    expect(view.deployable).toBe(false);
    expect(view.localContract).toMatchObject({ complete: true });
    expect(view.controlledCreation).toMatchObject({ available: true });
    expect(view.leadFormVocabulary.callToActionTypes.map((c) => c.code)).toContain("GET_QUOTE");
    expect(view.settings).toEqual([]);
    /* Explicit, so the builder infers nothing. */
    expect(view.settingsFrom).toBe("google_search");
    expect(view.requiredBiddingStrategy).toBe("target_cost_per_action");
    /* One type, one name, in the matrix and in readiness. */
    const controlled = readiness.CONTROLLED_CAMPAIGN_TYPES.find((t) => t.code === "google_lead_form");
    const cap = caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form;
    expect({ label: controlled.label, channelTerm: controlled.channelTerm })
      .toEqual({ label: cap.label, channelTerm: cap.channelTerm });
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${ACCOUNT}|${G.CONTROLLED_ACCOUNT_VAR}=`));
  });
});
