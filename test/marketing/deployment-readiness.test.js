// test/marketing/deployment-readiness.test.js
//
// CAMPAIGN DEPLOYMENT READINESS: WHAT GRAV CONFIRMED, AND WHAT NOBODY HAS ASKED.
//
// ── THE FAILURE THIS SUITE IS FOR ──────────────────────────────────────────
// A readiness feature's characteristic failure is optimism. It says a plan is ready
// because its own fields are filled in, and somebody reads that as "this will
// deploy". Every assertion below that looks pedantic — `deploymentReady` false for a
// perfect approved plan, six external checks that never shrink — is there because
// the alternative is a screen that promises something GRAV has not checked.
"use strict";

const express = require("express");
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
  MarketingCampaignDraft, MarketingCampaignDraftHistory,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const {
  MarketingCampaignDeployment,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptCounter,
  MarketingCampaignDeploymentAttemptIntent,
  MarketingCampaignDeploymentAttemptResult,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const attempts = require("../../services/marketing/campaignDrafts/deploymentAttempt.service");
const {
  MarketingCampaignIdentity,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignAllocation");
const service = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const readiness = require("../../services/marketing/campaignDrafts/deploymentReadiness.service");
const draftIdentity = require("../../services/marketing/campaignDrafts/draftIdentity");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const CEO = { id: new mongoose.Types.ObjectId().toString(), name: "Cy", role: "ceo", email: "cy@grav.in" };
const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Sam", role: "sales", email: "sam@grav.in" };

const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET"];
const savedEnv = {};
let app; let server; let base; let A; let B;
let keySeq = 0;
const freshKey = () => `readiness-key-${Date.now()}-${(keySeq += 1)}`.padEnd(12, "0");

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDrafts"));
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
});

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  A = a._id;
  B = b._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const call = async (path, { user = MARKETER, company = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
    },
  });
  return { status: res.status, body: await res.json() };
};

/* ── FIXTURES ────────────────────────────────────────────────────────────────
   A complete Google brief and a complete Meta brief, so a test can subtract one
   field and see exactly one finding rather than assembling a plan each time. */

const GOOGLE_BRIEF = Object.freeze({
  channel: "google_ads",
  campaignType: "google_search",
  destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
  geoTargeting: [{ name: "India", kind: "country" }],
  languages: ["en", "hi"],
  audiences: [{ name: "Hospitality buyers", kind: "search_intent" }],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "maximise_clicks" },
  /* Google v25 requires every new campaign to carry the advertiser's EU
     political-advertising declaration; GRAV never defaults it. */
  euPoliticalAdvertising: "does_not_contain",
  budgetRelationship: "campaign_total",
  googleSearch: {
    headlines: ["Winter uniforms", "Hotel uniforms", "Bulk orders"],
    descriptions: ["Made to measure for hospitality.", "Delivered across India."],
    keywordThemes: ["hotel uniforms", "hospital uniforms"],
  },
  timezone: "Asia/Kolkata",
});

const META_BRIEF = Object.freeze({
  channel: "meta_ads",
  campaignType: "meta_traffic_single_image",
  destination: { kind: "grav_landing_page", contentId: "41", capturedName: "Winter guide" },
  geoTargeting: [{ name: "Maharashtra", kind: "region" }],
  languages: ["en"],
  audiences: [{ name: "Hotel managers", kind: "interest" }],
  exclusionDecision: "listed",
  exclusions: [{ name: "Existing customers", kind: "custom_list" }],
  bidding: { strategy: "maximise_clicks" },
  budgetRelationship: "campaign_daily",
  metaSingleImage: {
    primaryText: "Winter uniforms for hospitality.",
    headline: "Order before October",
    callToAction: "Learn more",
    image: { kind: "landing_page", contentId: "88", capturedName: "Winter hero" },
  },
  timezone: "Asia/Kolkata",
});

const PLAN = Object.freeze({
  name: "Winter uniforms 2026",
  objective: "lead_generation",
  description: "Hospitality uniform enquiries.",
  channels: ["google_ads"],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 250000,
  budgetCurrency: "INR",
  budgetBasis: "total",
  conversionGoal: "form_submission",
  utmCampaign: "winter-uniforms-2026",
});

/* ── AN EXPLICIT `undefined` IS STILL A KEY ──────────────────────────────────
   `{ ...PLAN, budgetAmount: undefined }` keeps the property, and the write boundary
   asks `hasOwnProperty` rather than checking for undefined — deliberately, because
   a caller sending `null` means something different from omitting a field. So a
   test that wants a field ABSENT has to delete it. */
const withoutKeys = (object) => {
  const out = { ...object };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
};

/* ── A FRESH CAMPAIGN IDENTITY PER PLAN ──────────────────────────────────────
   A campaign identity is reserved permanently, including after cancellation, so a
   test creating two plans cannot reuse one. Fresh by default; a test that cares
   about a specific value still passes it. */
let utmSeq = 0;
const freshUtm = () => `readiness-plan-${(utmSeq += 1)}`;

const makePlan = async (over = {}, { company = null, user = MARKETER } = {}) => service.create({
  companyId: company || A, user,
  payload: withoutKeys({
    ...PLAN, utmCampaign: freshUtm(), idempotencyKey: freshKey(), ...over,
  }),
});

/* A plan carrying a complete Google brief. `briefOver` REPLACES fields; a field set
   to undefined is removed, which is how a test asks for one to be absent. */
const googlePlan = (over = {}, briefOver = {}) => makePlan({
  ...over,
  deploymentBriefs: [withoutKeys({ ...GOOGLE_BRIEF, ...briefOver })],
});

const readinessOf = async (plan, opts = {}) => service.deploymentReadiness({
  companyId: opts.company || A, campaignDraftId: plan.campaignDraftId,
});

const codesIn = (verdict) => verdict.sections.missingFromPlan
  .concat(verdict.sections.unsupportedByGrav, verdict.sections.contradictions)
  .map((f) => f.code);

/* ═══════════════════════════════════════════════════════════════════════════
   1. COMPLETE BRIEFS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a complete brief is plan-ready and still not deployment-ready", () => {
  test("a complete Google Search brief", async () => {
    const plan = await googlePlan();
    const verdict = await readinessOf(plan);

    expect(verdict.planReady).toBe(true);
    expect(verdict.counts.blocking).toBe(0);
    expect(codesIn(verdict)).toEqual([]);

    const google = verdict.channels.find((c) => c.channel === "google_ads");
    expect(google.planReady).toBe(true);
    expect(google.campaignTypeLabel).toBe("Search campaign");

    /* ── AND STILL NOT DEPLOYABLE ────────────────────────────────────────────
       Nothing has asked the advertising channel or the content library anything. */
    expect(verdict.deploymentReady).toBe(false);
    expect(verdict.sections.externalChecksRequired).toHaveLength(6);
    expect(verdict.deploymentBlockedBecause.join(" "))
      .toMatch(/have not been run/i);
  });

  test("a complete Meta single-image brief", async () => {
    const plan = await makePlan({
      channels: ["meta_ads"],
      budgetBasis: "daily",
      deploymentBriefs: [META_BRIEF],
    });
    const verdict = await readinessOf(plan);

    expect(verdict.planReady).toBe(true);
    expect(codesIn(verdict)).toEqual([]);

    const meta = verdict.channels.find((c) => c.channel === "meta_ads");
    expect(meta.campaignTypeLabel).toBe("Website traffic, single image");

    /* ── THE HONEST GAP, RECORDED ───────────────────────────────────────────
       The content library holds no advertising media, so the image reference is an
       EXTERNAL check rather than something GRAV claims it confirmed. Seven, not
       six: the media check is added on top. */
    expect(verdict.sections.externalChecksRequired).toHaveLength(7);
    expect(verdict.sections.externalChecksRequired.map((f) => f.code))
      .toContain("EXTERNAL_MEDIA_USABLE");
    expect(verdict.deploymentReady).toBe(false);
  });

  test("what GRAV locally confirmed is about the document, never the world", async () => {
    const plan = await googlePlan();
    const verdict = await readinessOf(plan);

    const confirmed = verdict.sections.locallyConfirmed.map((c) => c.code);
    expect(confirmed).toContain("BUDGET_RECORDED");
    expect(confirmed).toContain("SCHEDULE_RECORDED");
    expect(confirmed).toContain("TRACKING_IDENTITY_RECORDED");
    expect(confirmed).toContain("CAMPAIGN_TYPE_SUPPORTED");

    /* Each one is careful about what it does not claim. */
    const budget = verdict.sections.locallyConfirmed.find((c) => c.code === "BUDGET_RECORDED");
    expect(budget.detail).toMatch(/has not compared this currency/i);
    const type = verdict.sections.locallyConfirmed.find((c) => c.code === "CAMPAIGN_TYPE_SUPPORTED");
    expect(type.detail).toMatch(/not confirmed/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. WHAT BLOCKS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("each missing decision blocks, and says what to do", () => {
  /* Setting a field to undefined removes it, which `googlePlan` handles. Deleting
     from a copy and passing that copy as an override would not work: the override
     is merged ON TOP of the complete brief, so the deleted field would come back. */
  const withoutBrief = async (omit) => {
    const plan = await googlePlan({}, { [omit]: undefined });
    return readinessOf(plan);
  };

  test("an unsupported campaign type is refused at the write, before it is ever stored", async () => {
    /* GRAV will not store a type it has already decided it will never prepare. */
    await expect(googlePlan({}, { campaignType: "google_performance_max" }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    /* And an empty type is a missing decision the evaluator reports. */
    const verdict = await withoutBrief("campaignType");
    expect(codesIn(verdict)).toContain("CAMPAIGN_TYPE_MISSING");
    expect(verdict.planReady).toBe(false);
  });

  test("a type from the wrong channel is refused", async () => {
    await expect(makePlan({
      channels: ["meta_ads"],
      deploymentBriefs: [{ ...META_BRIEF, campaignType: "google_search" }],
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("a missing destination blocks", async () => {
    const verdict = await withoutBrief("destination");
    const finding = verdict.sections.missingFromPlan.find((f) => f.code === "DESTINATION_MISSING");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("blocking");
    expect(finding.channel).toBe("google_ads");
    expect(finding.field).toBe("destination");
    expect(finding.suggestedAction).toBeTruthy();
    expect(verdict.planReady).toBe(false);
  });

  test("a landing-page destination with no content identified blocks", async () => {
    const plan = await googlePlan({}, {
      destination: { kind: "grav_landing_page", contentId: "" },
    });
    const verdict = await readinessOf(plan);
    expect(codesIn(verdict)).toContain("DESTINATION_CONTENT_MISSING");
  });

  test("missing targeting and missing languages each block", async () => {
    expect(codesIn(await withoutBrief("geoTargeting"))).toContain("GEO_TARGETING_MISSING");
    expect(codesIn(await withoutBrief("languages"))).toContain("LANGUAGES_MISSING");
  });

  test("no exclusion DECISION blocks, and a decision of none does not", async () => {
    /* "No exclusions" and "nobody thought about exclusions" are different, and only
       the second should block. */
    const undecided = await withoutBrief("exclusionDecision");
    expect(codesIn(undecided)).toContain("EXCLUSION_DECISION_MISSING");

    const decided = await googlePlan({}, { exclusionDecision: "none_required", exclusions: [] });
    expect(codesIn(await readinessOf(decided))).not.toContain("EXCLUSION_DECISION_MISSING");
  });

  test("saying exclusions are listed and listing none is a contradiction", async () => {
    const plan = await googlePlan({}, { exclusionDecision: "listed", exclusions: [] });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.contradictions.find((f) => f.code === "EXCLUSION_DECISION_MISSING");
    expect(finding).toBeTruthy();
  });

  test("missing bidding blocks, and a strategy needing a target needs one", async () => {
    expect(codesIn(await withoutBrief("bidding"))).toContain("BIDDING_MISSING");

    const noTarget = await googlePlan({}, {
      bidding: { strategy: "target_cost_per_click" },
    });
    expect(codesIn(await readinessOf(noTarget))).toContain("BIDDING_TARGET_MISSING");

    const withTarget = await googlePlan({}, {
      bidding: { strategy: "target_cost_per_click", target: { amount: 40, currency: "INR" } },
    });
    expect(codesIn(await readinessOf(withTarget))).not.toContain("BIDDING_TARGET_MISSING");
  });

  test("optimising towards a goal the channel cannot see is a contradiction", async () => {
    const plan = await googlePlan({ conversionGoal: "qualified_prospect" }, {
      bidding: { strategy: "target_cost_per_action", target: { amount: 900, currency: "INR" } },
    });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.contradictions.find((f) => f.code === "BIDDING_NEEDS_CONVERSION_GOAL");
    expect(finding).toBeTruthy();
    expect(finding.explanation).toMatch(/never told about/i);
  });

  test("incomplete Google creative blocks and counts what is there", async () => {
    const plan = await googlePlan({}, {
      googleSearch: { headlines: ["Only one"], descriptions: ["Only one"], keywordThemes: ["uniforms"] },
    });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.missingFromPlan.find((f) => f.code === "CREATIVE_INCOMPLETE");
    expect(finding.explanation).toMatch(/This plan has 1 and 1/);
  });

  test("Google creative with no search terms blocks", async () => {
    const plan = await googlePlan({}, {
      googleSearch: { ...GOOGLE_BRIEF.googleSearch, keywordThemes: [] },
    });
    expect(codesIn(await readinessOf(plan))).toContain("CREATIVE_INCOMPLETE");
  });

  test("incomplete Meta creative names each missing part", async () => {
    const plan = await makePlan({
      channels: ["meta_ads"], budgetBasis: "daily",
      deploymentBriefs: [{
        ...META_BRIEF,
        metaSingleImage: { ...META_BRIEF.metaSingleImage, headline: "", callToAction: "" },
      }],
    });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.missingFromPlan.find((f) => f.code === "CREATIVE_INCOMPLETE");
    expect(finding.explanation).toMatch(/a headline, a call to action/);
  });

  test("a Meta advertisement with no image blocks", async () => {
    const plan = await makePlan({
      channels: ["meta_ads"], budgetBasis: "daily",
      deploymentBriefs: [{
        ...META_BRIEF,
        metaSingleImage: { ...META_BRIEF.metaSingleImage, image: { kind: "", contentId: "" } },
      }],
    });
    expect(codesIn(await readinessOf(plan))).toContain("MEDIA_REFERENCE_MISSING");
  });

  test("a goal the campaign type cannot pursue is a contradiction, never remapped", async () => {
    const plan = await googlePlan({ conversionGoal: "channel_conversion" });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.contradictions.find((f) => f.code === "CONVERSION_GOAL_INCOMPATIBLE");
    expect(finding).toBeTruthy();
    expect(finding.explanation).toMatch(/will not map it onto a different one/i);
  });

  test("a missing tracking identity blocks", async () => {
    const plan = await googlePlan({ utmCampaign: "" });
    expect(codesIn(await readinessOf(plan))).toContain("TRACKING_IDENTITY_MISSING");
  });

  test("a missing timezone blocks", async () => {
    const verdict = await withoutBrief("timezone");
    const finding = verdict.sections.missingFromPlan.find((f) => f.code === "SCHEDULE_TIMEZONE_MISSING");
    expect(finding.explanation).toMatch(/up to a day/i);
  });

  test("a missing budget arrangement blocks, and one contradicting the basis is a contradiction", async () => {
    expect(codesIn(await withoutBrief("budgetRelationship"))).toContain("BUDGET_RELATIONSHIP_MISSING");

    /* The plan's budget is a total; the brief calls it a daily rate. */
    const clash = await googlePlan({}, { budgetRelationship: "campaign_daily" });
    expect(codesIn(await readinessOf(clash))).toContain("BUDGET_BASIS_CONTRADICTS_RELATIONSHIP");
  });

  test("a Meta-only budget arrangement is unsupported on Google", async () => {
    const plan = await googlePlan({ budgetBasis: "daily" }, { budgetRelationship: "ad_set_daily" });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.unsupportedByGrav.find((f) => f.code === "BUDGET_RELATIONSHIP_WRONG_CHANNEL");
    expect(finding).toBeTruthy();
  });

  test("a channel with no brief at all blocks", async () => {
    const plan = await makePlan({ deploymentBriefs: [] });
    const verdict = await readinessOf(plan);
    expect(codesIn(verdict)).toContain("BRIEF_MISSING");
    /* And the external checks are still listed: nobody has asked them either. */
    expect(verdict.sections.externalChecksRequired).toHaveLength(6);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. BUDGET AND SCHEDULE AT THE PLAN LEVEL
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a zero budget is a value; an absent one is not", () => {
  test("zero is recorded and does not block", async () => {
    const plan = await googlePlan({ budgetAmount: 0 });
    const verdict = await readinessOf(plan);

    /* `!budget.amount` would have called this missing. A plan with no spend is a
       real plan, and telling somebody their budget is missing when they set it to
       nothing is both wrong and confusing. */
    expect(codesIn(verdict)).not.toContain("BUDGET_MISSING");
    expect(verdict.planReady).toBe(true);
    expect(verdict.sections.locallyConfirmed.find((c) => c.code === "BUDGET_RECORDED").detail)
      .toMatch(/^0 INR/);
  });

  test("an absent budget blocks, and says a zero would have been fine", async () => {
    const plan = await googlePlan({
      budgetAmount: undefined, budgetCurrency: undefined, budgetBasis: undefined,
    });
    const verdict = await readinessOf(plan);
    const finding = verdict.sections.missingFromPlan.find((f) => f.code === "BUDGET_MISSING");
    expect(finding.explanation).toMatch(/budget of zero is a legitimate amount/i);
    expect(verdict.planReady).toBe(false);
  });

  test("an incomplete schedule blocks", async () => {
    const plan = await googlePlan({ startDate: undefined, endDate: undefined });
    expect(codesIn(await readinessOf(plan))).toContain("SCHEDULE_INCOMPLETE");
  });

  test("a reversed schedule is a contradiction", async () => {
    /* The plan's own write boundary refuses a reversed range, so this is asserted
       against the evaluator directly — its job is to catch one however it arrived. */
    const verdict = readiness.evaluate({
      plan: {
        channels: ["google_ads"], state: "draft",
        budget: { amount: 1, currency: "INR", basis: "total" },
        schedule: { startDate: "2026-12-15", endDate: "2026-10-01" },
        conversionGoal: "form_submission", utmCampaign: "x",
        contentRefs: [], deploymentBriefs: [],
      },
    });
    const finding = verdict.sections.contradictions.find((f) => f.code === "SCHEDULE_REVERSED");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("blocking");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. MULTIPLE CHANNELS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("channels are judged independently", () => {
  test("one ready channel and one blocked channel", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "meta_ads"],
      deploymentBriefs: [
        GOOGLE_BRIEF,
        /* Meta's brief is missing its creative. */
        { ...META_BRIEF, metaSingleImage: { primaryText: "", headline: "", callToAction: "", image: { kind: "", contentId: "" } } },
      ],
    });
    const verdict = await readinessOf(plan);

    const google = verdict.channels.find((c) => c.channel === "google_ads");
    const meta = verdict.channels.find((c) => c.channel === "meta_ads");

    expect(google.planReady).toBe(true);
    expect(google.blockingCount).toBe(0);
    expect(meta.planReady).toBe(false);
    expect(meta.blockingCount).toBeGreaterThan(0);

    /* One blocked channel blocks the plan. A plan is not half ready. */
    expect(verdict.planReady).toBe(false);

    /* Every Meta finding names Meta, so a reader can act on the right one. */
    for (const f of meta.findings.filter((x) => x.severity === "blocking")) {
      expect(f.channel).toBe("meta_ads");
    }
  });

  test("a channel that publishes no advertising is advisory, not unsupported-type", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "email"],
      deploymentBriefs: [GOOGLE_BRIEF],
    });
    const verdict = await readinessOf(plan);

    const email = verdict.channels.find((c) => c.channel === "email");
    expect(email.publishesAdvertising).toBe(false);
    expect(email.planReady).toBe(true);
    /* There is no campaign type to support, so saying "unsupported campaign type"
       would send somebody looking for a setting that does not exist. */
    const finding = email.findings.find((f) => f.code === "CHANNEL_NOT_A_PUBLISHER");
    expect(finding.severity).toBe("advisory");
    expect(finding.group).toBe("not_applicable");
    expect(verdict.planReady).toBe(true);

    /* And the internal engine is never named. */
    expect(JSON.stringify(verdict)).not.toMatch(/mautic/i);
    expect(JSON.stringify(verdict)).not.toMatch(/MAUTIC_/);
  });

  test("google_analytics is a measurement source and needs no brief", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "google_analytics"],
      deploymentBriefs: [GOOGLE_BRIEF],
    });
    const verdict = await readinessOf(plan);
    const ga = verdict.channels.find((c) => c.channel === "google_analytics");
    expect(ga.publishesAdvertising).toBe(false);
    expect(ga.findings[0].explanation).toMatch(/measures activity/i);
    expect(verdict.planReady).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. LIFECYCLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("readiness respects the plan's lifecycle", () => {
  const approvedPlan = async () => {
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    await service.decide({ companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve" });
    return plan;
  };

  test("a draft that is locally complete is approval-ready and not deployment-ready", async () => {
    const plan = await googlePlan();
    const verdict = await readinessOf(plan);

    expect(verdict.planState).toBe("draft");
    expect(verdict.planReady).toBe(true);
    expect(verdict.approvalReady).toBe(true);
    /* A draft can never be deployment-ready, whatever else is true. */
    expect(verdict.deploymentReady).toBe(false);
    expect(verdict.deploymentBlockedBecause.join(" ")).toMatch(/has not been approved/i);
  });

  test("an approved, locally complete plan is still awaiting external preflight", async () => {
    const plan = await approvedPlan();
    const verdict = await readinessOf(plan);

    expect(verdict.planState).toBe("approved");
    expect(verdict.planReady).toBe(true);
    /* Nothing left to approve. */
    expect(verdict.approvalReady).toBe(false);

    /* ── THE ASSERTION THIS WHOLE CHUNK EXISTS FOR ──────────────────────────
       A perfect, approved plan is NOT deployment-ready, because nobody has asked
       the advertising channel or the content library anything. */
    expect(verdict.deploymentReady).toBe(false);
    expect(verdict.deploymentBlockedBecause).toEqual([
      "the checks that only the advertising channel and the content library can answer have not been run",
    ]);
    expect(verdict.counts.blocking).toBe(0);
    expect(verdict.counts.externalOutstanding).toBe(6);
  });

  test("returned, rejected and cancelled plans are never approval-ready", async () => {
    for (const decision of ["return", "reject"]) {
      const plan = await googlePlan({ utmCampaign: `utm-${decision}` });
      await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
      await service.decide({
        companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId,
        decision, reason: "Because.",
      });
      const verdict = await readinessOf(plan);

      if (decision === "return") {
        /* Editable again, so it can be resubmitted. */
        expect(verdict.planState).toBe("returned");
        expect(verdict.approvalReady).toBe(true);
      } else {
        expect(verdict.planState).toBe("rejected");
        expect(verdict.approvalReady).toBe(false);
      }
      expect(verdict.deploymentReady).toBe(false);
    }

    const cancelled = await googlePlan({ utmCampaign: "utm-cancelled" });
    await service.cancel({ companyId: A, user: MARKETER, campaignDraftId: cancelled.campaignDraftId, reason: "No." });
    const verdict = await readinessOf(cancelled);
    expect(verdict.planState).toBe("cancelled");
    expect(verdict.approvalReady).toBe(false);
    expect(verdict.deploymentReady).toBe(false);
  });

  test("a submitted plan's brief is frozen, like every other field", async () => {
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });

    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { deploymentBriefs: [{ ...GOOGLE_BRIEF, timezone: "Europe/London" }], expectedRevision: 2 },
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_STATE_CONFLICT" });
  });

  test("approval's meaning is stated in the response, not implied", async () => {
    const plan = await approvedPlan();
    const verdict = await readinessOf(plan);

    expect(verdict.approvalMeaning).toMatchObject({
      approved: true,
      createdAnything: false,
      committedMoney: false,
      activatedDelivery: false,
      providerAccepted: false,
      deliveryObjectsNonDeliveringConfirmed: false,
    });
    expect(verdict.approvalMeaning.means).toMatch(/Nothing has been created in any advertising channel/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. DETERMINISM AND VERSIONING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the same snapshot always produces the same verdict", () => {
  test("identical snapshots give identical findings, in the same order", async () => {
    const plan = await googlePlan({}, { bidding: { strategy: "target_cost_per_click" } });

    const one = await readinessOf(plan);
    const two = await readinessOf(plan);

    const strip = (v) => JSON.stringify({ ...v, evaluatedAt: null });
    expect(strip(one)).toBe(strip(two));
  });

  test("the evaluator version and the evaluated revision travel with the answer", async () => {
    const plan = await googlePlan();
    const first = await readinessOf(plan);

    expect(first.evaluatorVersion).toBe(readiness.EVALUATOR_VERSION);
    expect(first.evaluatedRevision).toBe(1);
    expect(first.evaluatedAt).toBeTruthy();

    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { name: "Renamed", expectedRevision: 1 },
    });

    const second = await readinessOf(plan);
    /* ── A HELD RESULT CANNOT BE MISTAKEN FOR A CURRENT ONE ─────────────────
       The revision is what makes a stale answer visible as stale. */
    expect(second.evaluatedRevision).toBe(2);
    expect(second.evaluatedRevision).not.toBe(first.evaluatedRevision);
  });

  test("every finding carries the full shape a reader needs", async () => {
    const plan = await googlePlan({}, { destination: null, bidding: null });
    const verdict = await readinessOf(plan);

    const findings = verdict.channels.flatMap((c) => c.findings);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(Object.keys(f).sort()).toEqual(
        ["channel", "code", "explanation", "field", "group", "severity", "suggestedAction", "title"],
      );
      expect(typeof f.code).toBe("string");
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.explanation.length).toBeGreaterThan(0);
      expect(f.suggestedAction.length).toBeGreaterThan(0);
      expect(["blocking", "advisory"]).toContain(f.severity);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. THE ROUTE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the readiness route reads, and does nothing else", () => {
  test("Marketing and administrators may read it; Sales may not", async () => {
    const plan = await googlePlan();
    const path = `/campaign-drafts/${encodeURIComponent(plan.campaignDraftId)}/deployment-readiness`;

    for (const user of [MARKETER, ADMIN, CEO]) {
      const res = await call(path, { user });
      expect(res.status).toBe(200);
      expect(res.body.planReady).toBe(true);
    }

    /* A campaign is not Sales' to plan, approve or prepare. */
    const refused = await call(path, { user: SALES });
    expect(refused.status).toBe(403);
  });

  test("another company cannot read the plan", async () => {
    const plan = await googlePlan();
    const res = await call(
      `/campaign-drafts/${encodeURIComponent(plan.campaignDraftId)}/deployment-readiness`,
      { company: B },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_NOT_FOUND");
  });

  test("a malformed or forged identifier is refused", async () => {
    const plan = await googlePlan();
    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();

    for (const bad of [
      "not-an-identifier",
      `${plan.campaignDraftId}x`,
      draftIdentity.encodeDraftId({ companyId: String(B), draftId: String(stored._id) }),
    ]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(bad)}/deployment-readiness`);
      expect(res.status).toBe(404);
    }
  });

  test("evaluating creates no database record of any kind", async () => {
    const plan = await googlePlan();

    const before = {
      drafts: await MarketingCampaignDraft.countDocuments({}),
      history: await MarketingCampaignDraftHistory.countDocuments({}),
      deployments: await MarketingCampaignDeployment.countDocuments({}),
    };

    for (let i = 0; i < 3; i += 1) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(plan.campaignDraftId)}/deployment-readiness`);
      expect(res.status).toBe(200);
    }

    /* ── NO READINESS RESULT IS PERSISTED AS CURRENT TRUTH ──────────────────
       A readiness answer is a judgement about a document at a moment, not a fact
       about it. Storing one would immediately be read as current by something that
       should have re-evaluated. */
    expect({
      drafts: await MarketingCampaignDraft.countDocuments({}),
      history: await MarketingCampaignDraftHistory.countDocuments({}),
      deployments: await MarketingCampaignDeployment.countDocuments({}),
    }).toEqual(before);

    /* And no deployment record exists at all in this chunk. */
    expect(before.deployments).toBe(0);
  });

  test("approval creates no deployment record either", async () => {
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    await service.decide({ companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve" });

    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
  });

  test("the response carries the plan revision, the version and the evaluation time", async () => {
    const plan = await googlePlan();
    const res = await call(`/campaign-drafts/${encodeURIComponent(plan.campaignDraftId)}/deployment-readiness`);

    expect(res.body.evaluatedRevision).toBe(1);
    expect(res.body.evaluatorVersion).toBe(readiness.EVALUATOR_VERSION);
    expect(res.body.evaluatedAt).toBeTruthy();
    expect(res.body.reference).toMatch(/^MCP-\d{4}-\d{4}$/);
  });

  test("no provider identifier, credential or error language reaches the response", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "meta_ads", "email"],
      deploymentBriefs: [GOOGLE_BRIEF, { ...META_BRIEF, budgetRelationship: "campaign_total" }],
    });
    const res = await call(`/campaign-drafts/${encodeURIComponent(plan.campaignDraftId)}/deployment-readiness`);
    const text = JSON.stringify(res.body);

    /* The internal engine is never named, anywhere. */
    expect(text).not.toMatch(/mautic/i);
    expect(text).not.toMatch(/MAUTIC_/);

    /* No provider host, path, credential or driver language. */
    for (const leak of [
      "googleads.googleapis.com", "graph.facebook.com", "analyticsdata",
      "/api/emails", "customer_id", "access_token", "developer-token",
      "Bearer ", "E11000", "MongoServerError", "OAuthException",
    ]) {
      expect(text).not.toContain(leak);
    }

    /* The advertising channels ARE named: a marketer holds those accounts. */
    expect(text).toContain("Google Ads");
    expect(text).toContain("Meta Ads");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. THE SOURCE-LEVEL GUARDS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nothing in this path can reach a provider or write a deployment", () => {
  const read = (...parts) => require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", ...parts), "utf8",
  );

  test("the evaluator and the route load no provider client and no HTTP client", () => {
    const files = [
      ["services", "marketing", "campaignDrafts", "deploymentReadiness.service.js"],
      ["services", "marketing", "campaignDrafts", "campaignDraft.service.js"],
      ["routes", "CMS_Routes", "Marketing", "campaignDrafts.js"],
    ];
    for (const parts of files) {
      const src = read(...parts);
      /* The structural half of the guarantee. A readiness evaluator that could
         reach a provider would, sooner or later, be the thing that created a
         campaign while answering a question. */
      for (const forbidden of [
        /require\([^)]*googleAdsClient/,
        /require\([^)]*metaAdsClient/,
        /require\([^)]*googleAnalyticsClient/,
        /require\([^)]*channelHttp/,
        /require\(['"]axios['"]\)/,
        /require\(['"]node-fetch['"]\)/,
        /require\([^)]*mauticClient/,
      ]) {
        expect(src).not.toMatch(forbidden);
      }
    }
  });

  test("nothing on this path loads a deployment writer", () => {
    for (const parts of [
      ["services", "marketing", "campaignDrafts", "deploymentReadiness.service.js"],
      ["services", "marketing", "campaignDrafts", "campaignDraft.service.js"],
      ["routes", "CMS_Routes", "Marketing", "campaignDrafts.js"],
    ]) {
      expect(read(...parts)).not.toMatch(/MarketingCampaignDeployment/);
    }
  });

  test("the evaluator reads no database at all", () => {
    const src = read("services", "marketing", "campaignDrafts", "deploymentReadiness.service.js");
    /* It takes a snapshot. A model import would let it read, and a read is a
       dependency on state the caller did not pass in — which is what would make two
       evaluations of one snapshot disagree. */
    expect(src).not.toMatch(/require\([^)]*models\//);
    expect(src).not.toMatch(/mongoose/);
  });

  test("the evaluator is pure: no plan, no throw, no mutation of its input", () => {
    const snapshot = {
      channels: ["google_ads"], state: "draft",
      budget: { amount: 10, currency: "INR", basis: "total" },
      schedule: { startDate: "2026-10-01", endDate: "2026-10-31" },
      conversionGoal: "form_submission", utmCampaign: "x",
      contentRefs: [], deploymentBriefs: [],
    };
    const frozen = JSON.stringify(snapshot);

    readiness.evaluate({ plan: snapshot });
    readiness.evaluate({ plan: snapshot });

    /* The input is untouched. An evaluator that normalised its argument would make
       the second call a different call. */
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });

  test("the deployment record exists and nothing has written one", async () => {
    /* Defined now because the shape is a decision, and deciding it while nothing
       depends on it is the only time it can be decided calmly. */
    expect(MarketingCampaignDeployment).toBeTruthy();
    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);

    const paths = MarketingCampaignDeployment.schema.paths;
    /* The provider's own ids live HERE and never on the plan. */
    expect(paths.externalObjects).toBeTruthy();
    expect(paths.approvedRevision).toBeTruthy();
    expect(paths.idempotencyKey).toBeTruthy();
    expect(paths.state.options.enum).toEqual([
      "not_started", "preparing", "partially_created", "paused_confirmed", "failed", "activated",
    ]);
  });

  test("a plan still holds no provider identifier, even with full briefs", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "meta_ads"],
      deploymentBriefs: [GOOGLE_BRIEF, { ...META_BRIEF, budgetRelationship: "campaign_total" }],
    });
    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    const text = JSON.stringify(stored);

    for (const forbidden of ["providerCampaignId", "adAccountId", "accessToken", "customerId"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(plan.deploymentBriefs).toHaveLength(2);
  });

  test("a brief carrying a provider identifier or a script is refused by name", async () => {
    for (const field of ["providerCampaignId", "adAccountId", "accessToken", "customHtml"]) {
      await expect(makePlan({
        deploymentBriefs: [{ ...GOOGLE_BRIEF, [field]: "anything" }],
      })).rejects.toMatchObject({ code: "VALIDATION" });
    }

    /* And one nested inside the brief's own objects, which a top-level allowlist
       cannot see. */
    await expect(makePlan({
      deploymentBriefs: [{
        ...GOOGLE_BRIEF,
        destination: { kind: "grav_site_url", url: "https://grav.in/x", accessToken: "secret" },
      }],
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. READINESS AND APPROVAL TELL ONE TRUTH
   ═══════════════════════════════════════════════════════════════════════════

   The contradiction this closes: readiness reported `approvalReady: false` while
   `submit()` happily moved the same plan to awaiting_approval and `decide()`
   approved it. Two parts of one product told a marketer two different things about
   one plan, and the part that actually moved the record was the part that checked
   nothing. */

describe("an incomplete advertising plan cannot be submitted or approved", () => {
  const incompleteGoogle = () => googlePlan({}, { destination: undefined, bidding: undefined });

  test("1. an incomplete Google plan cannot be submitted", async () => {
    const plan = await incompleteGoogle();

    /* Readiness says so. */
    const verdict = await readinessOf(plan);
    expect(verdict.approvalReady).toBe(false);

    /* And so does submission, using the same evaluator. */
    let caught = null;
    try {
      await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    } catch (err) { caught = err; }

    expect(caught?.code).toBe("CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE");
    expect(caught.status).toBe(422);

    /* Grouped the way readiness groups them, so one plan is described in one
       vocabulary. Not an internal exception and not provider text. */
    const groups = caught.details.advertisingReadiness;
    expect(groups.applicable).toBe(true);
    expect(groups.evaluatorVersion).toBe(readiness.EVALUATOR_VERSION);
    expect(groups.evaluatedRevision).toBe(1);
    expect(groups.missingFromPlan.map((f) => f.code)).toContain("DESTINATION_MISSING");
    expect(groups.missingFromPlan.map((f) => f.code)).toContain("BIDDING_MISSING");
    for (const f of groups.missingFromPlan) expect(f.suggestedAction).toBeTruthy();

    /* Nothing moved. */
    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(stored.state).toBe("draft");
    expect(stored.revision).toBe(1);
  });

  test("1b. an incomplete Meta plan cannot be submitted", async () => {
    const plan = await makePlan({
      channels: ["meta_ads"], budgetBasis: "daily",
      deploymentBriefs: [withoutKeys({ ...META_BRIEF, metaSingleImage: undefined })],
    });

    await expect(service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" });

    expect((await MarketingCampaignDraft.findOne({ companyId: A }).lean()).state).toBe("draft");
  });

  test("2. a legacy incomplete awaiting-approval plan cannot be approved", async () => {
    /* Submitted while complete, then the brief is emptied behind GRAV's back — which
       is what a plan from before this rule existed looks like. */
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });

    await MarketingCampaignDraft.updateOne(
      { companyId: A },
      { $set: { "deploymentBriefs.0.destination": null, "deploymentBriefs.0.bidding": null } },
    );

    /* ── RE-EVALUATED AT APPROVAL ─────────────────────────────────────────────
       An approval is the consequential step, so it checks rather than trusting that
       submission did. */
    let caught = null;
    try {
      await service.decide({ companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve" });
    } catch (err) { caught = err; }

    expect(caught?.code).toBe("CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE");
    expect(caught.message).toMatch(/cannot be approved/i);
    expect(caught.message).toMatch(/returned or rejected/i);

    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(stored.state).toBe("awaiting_approval");
  });

  test("3. return and reject remain available on an incomplete plan", async () => {
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    await MarketingCampaignDraft.updateOne(
      { companyId: A }, { $set: { "deploymentBriefs.0.destination": null } },
    );

    /* Nobody is stuck: the plan can be sent back or ended. */
    const returned = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId,
      decision: "return", reason: "Add the destination.",
    });
    expect(returned.state).toBe("returned");

    const second = await googlePlan({}, { bidding: undefined });
    /* It cannot be submitted at all, so reject is exercised on a plan that reached
       awaiting_approval while complete. */
    const third = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: third.campaignDraftId, expectedRevision: third.revision });
    await MarketingCampaignDraft.updateOne(
      { companyId: A, draftRef: third.reference }, { $set: { "deploymentBriefs.0.bidding": null } },
    );
    const rejected = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: third.campaignDraftId,
      decision: "reject", reason: "Not this quarter.",
    });
    expect(rejected.state).toBe("rejected");
    expect(second.state).toBe("draft");
  });

  test("4. outstanding external checks do not prevent submission", async () => {
    const plan = await googlePlan();
    const verdict = await readinessOf(plan);

    /* Six things nobody has asked, and none of them is GRAV's to answer. Blocking
       submission on them would make every plan permanently unapprovable. */
    expect(verdict.sections.externalChecksRequired).toHaveLength(6);
    expect(verdict.planReady).toBe(true);

    const submitted = await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    expect(submitted.state).toBe("awaiting_approval");

    const approved = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve",
    });
    expect(approved.state).toBe("approved");

    /* And it is still not deployment-ready. */
    expect((await readinessOf(plan)).deploymentReady).toBe(false);
  });

  test("a duplicate submission stays idempotent", async () => {
    const plan = await googlePlan();
    const first = await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    const second = await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.revision).toBe(first.revision);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A, kind: "submitted" })).toBe(1);
  });

  test("5. an email-only plan keeps the ordinary approval rules", async () => {
    const plan = await makePlan({ channels: ["email"], deploymentBriefs: [] });

    /* No advertising gate applies, so the ordinary lifecycle is the whole rule. */
    const submitted = await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    expect(submitted.state).toBe("awaiting_approval");
    const approved = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve",
    });
    expect(approved.state).toBe("approved");
  });

  test("5b. readiness for an email-only plan is explicitly non-applicable", async () => {
    const plan = await makePlan({ channels: ["email"], deploymentBriefs: [] });
    const verdict = await readinessOf(plan);

    /* ── DEFINED, NOT LEFT TO A CLIENT TO INFER ──────────────────────────────
       Every boolean has a stated value for this case. */
    expect(verdict.applicable).toBe(false);
    expect(verdict.planReady).toBe(true);
    expect(verdict.approvalReady).toBe(true);
    expect(verdict.deploymentReady).toBe(false);

    /* And it is NOT described as missing advertising information. */
    expect(verdict.sections.missingFromPlan).toEqual([]);
    expect(verdict.sections.unsupportedByGrav).toEqual([]);
    expect(verdict.sections.contradictions).toEqual([]);
    expect(verdict.sections.externalChecksRequired).toEqual([]);

    /* The one finding there IS lives in its own section: the email channel carries
       no advertisements, which is information about the channel rather than a
       problem with the plan. */
    expect(verdict.sections.notApplicable).toHaveLength(1);
    expect(verdict.sections.notApplicable[0].code).toBe("CHANNEL_NOT_A_PUBLISHER");
    expect(verdict.deploymentBlockedBecause).toEqual([
      "this plan has no advertising channel, so there is nothing to deploy to one",
    ]);
    expect(verdict.counts).toEqual({ blocking: 0, advisory: 1, externalOutstanding: 0 });

    /* The one advisory is the email channel saying it carries no advertising, which
       is information rather than a problem. */
    const email = verdict.channels.find((c) => c.channel === "email");
    expect(email.findings[0].severity).toBe("advisory");
    expect(JSON.stringify(verdict)).not.toMatch(/mautic/i);
  });

  test("a measurement-only plan is non-applicable too", async () => {
    const plan = await makePlan({ channels: ["google_analytics"], deploymentBriefs: [] });
    const verdict = await readinessOf(plan);
    expect(verdict.applicable).toBe(false);
    expect(verdict.planReady).toBe(true);
    expect(verdict.sections.missingFromPlan).toEqual([]);
  });

  test("a mixed plan is applicable, and the advertising channel is judged", async () => {
    const plan = await makePlan({
      channels: ["email", "google_ads"],
      deploymentBriefs: [withoutKeys({ ...GOOGLE_BRIEF, destination: undefined })],
    });
    const verdict = await readinessOf(plan);

    expect(verdict.applicable).toBe(true);
    expect(verdict.planReady).toBe(false);
    await expect(service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. A CHANNEL EDIT CANNOT ORPHAN A BRIEF
   ═══════════════════════════════════════════════════════════════════════════ */

describe("changing channels cannot silently strand marketer-entered work", () => {
  test("6. removing a channel without its brief is refused, with zero writes", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "meta_ads"],
      deploymentBriefs: [GOOGLE_BRIEF, { ...META_BRIEF, budgetRelationship: "campaign_total" }],
    });

    const before = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    const historyBefore = await MarketingCampaignDraftHistory.countDocuments({ companyId: A });
    const identitiesBefore = await MarketingCampaignIdentity.countDocuments({ companyId: A });

    let caught = null;
    try {
      await service.update({
        companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
        payload: { channels: ["google_ads"], expectedRevision: 1 },
      });
    } catch (err) { caught = err; }

    expect(caught?.code).toBe("VALIDATION");
    expect(caught.details.orphanedBriefs).toEqual(["meta_ads"]);
    /* GRAV will not delete what somebody typed, and says what to send instead. */
    expect(caught.message).toMatch(/will not delete what you wrote/i);
    expect(caught.message).toMatch(/together/i);

    /* ── ZERO WRITES ────────────────────────────────────────────────────────
       No revision, no history row, no identity change, and not even a timestamp. */
    const after = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.channels).toEqual(before.channels);
    expect(after.deploymentBriefs).toHaveLength(2);
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(historyBefore);
    expect(await MarketingCampaignIdentity.countDocuments({ companyId: A })).toBe(identitiesBefore);
  });

  test("7. changing channels and briefs together succeeds", async () => {
    const plan = await makePlan({
      channels: ["google_ads", "meta_ads"],
      deploymentBriefs: [GOOGLE_BRIEF, { ...META_BRIEF, budgetRelationship: "campaign_total" }],
    });

    const edited = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { channels: ["google_ads"], deploymentBriefs: [GOOGLE_BRIEF], expectedRevision: 1 },
    });

    expect(edited.channels).toEqual(["google_ads"]);
    expect(edited.deploymentBriefs).toHaveLength(1);
    expect(edited.revision).toBe(2);
    expect((await readinessOf(plan)).planReady).toBe(true);
  });

  test("8. adding an advertising channel without its brief is a valid draft, reported as incomplete", async () => {
    const plan = await makePlan({ channels: ["google_ads"], deploymentBriefs: [GOOGLE_BRIEF] });

    /* Adding a channel orphans nothing, so the edit stands. */
    const edited = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { channels: ["google_ads", "meta_ads"], expectedRevision: 1 },
    });
    expect(edited.channels).toEqual(["google_ads", "meta_ads"]);
    expect(edited.revision).toBe(2);

    /* Readiness reports the missing brief rather than the write refusing it:
       drafting towards a second channel is a legitimate intermediate state. */
    const verdict = await readinessOf(plan);
    expect(verdict.planReady).toBe(false);
    const meta = verdict.channels.find((c) => c.channel === "meta_ads");
    expect(meta.findings.map((f) => f.code)).toContain("BRIEF_MISSING");

    /* And it cannot be submitted until the brief is there. */
    await expect(service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: edited.revision }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" });
  });

  test("removing a non-advertising channel with no brief is unaffected", async () => {
    const plan = await makePlan({ channels: ["google_ads", "email"], deploymentBriefs: [GOOGLE_BRIEF] });
    const edited = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { channels: ["google_ads"], expectedRevision: 1 },
    });
    expect(edited.channels).toEqual(["google_ads"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. THE EVALUATOR COERCES NOTHING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the evaluator refuses coercible values and keeps a genuine zero", () => {
  const snapshot = (over = {}) => ({
    channels: ["google_ads"], state: "draft",
    budget: { amount: 100, currency: "INR", basis: "total" },
    schedule: { startDate: "2026-10-01", endDate: "2026-10-31" },
    conversionGoal: "form_submission", utmCampaign: "x",
    contentRefs: [],
    deploymentBriefs: [{
      channel: "google_ads", campaignType: "google_search",
      destination: { kind: "grav_site_url", url: "https://grav.in/x" },
      geoTargeting: [{ name: "India", kind: "country" }],
      languages: ["en"],
      exclusionDecision: "none_required", exclusions: [],
      bidding: { strategy: "target_cost_per_click", target: { amount: 40, currency: "INR" } },
      budgetRelationship: "campaign_total",
      googleSearch: { headlines: ["a", "b", "c"], descriptions: ["d", "e"], keywordThemes: ["k"] },
      timezone: "Asia/Kolkata",
    }],
    ...over,
  });

  const codesOf = (plan) => {
    const v = readiness.evaluate({ plan });
    return v.sections.missingFromPlan.concat(v.sections.contradictions).map((f) => f.code);
  };

  const withTarget = (amount, currency = "INR") => {
    const plan = snapshot();
    plan.deploymentBriefs[0].bidding.target = { amount, currency };
    return plan;
  };

  test("9. only a finite JSON number is a supplied bidding target", () => {
    /* `Number(x)` made every one of these look like a supplied zero: `Number(null)`
       is 0, so is `Number("")`, `Number(false)` and `Number("0")`. A readiness
       evaluator that collapses them is the one thing the plan contract is written
       to prevent, reintroduced inside the judge. */
    for (const bad of [null, undefined, "", "0", "40", false, true, NaN, Infinity, [], {}, [40]]) {
      expect(codesOf(withTarget(bad))).toContain("BIDDING_TARGET_MISSING");
    }

    /* A genuine numeric zero IS a value: a target of nothing is a decision
       somebody typed. */
    expect(codesOf(withTarget(0))).not.toContain("BIDDING_TARGET_MISSING");
    expect(codesOf(withTarget(40))).not.toContain("BIDDING_TARGET_MISSING");
  });

  test("9b. a coercible target currency is not a currency", () => {
    for (const bad of [null, "", false, 0, 123, {}]) {
      expect(codesOf(withTarget(40, bad))).toContain("BIDDING_TARGET_MISSING");
    }
    expect(codesOf(withTarget(40, "INR"))).not.toContain("BIDDING_TARGET_MISSING");
  });

  test("a budget amount that is not a number is missing, never read as zero", () => {
    for (const bad of [null, "", "0", "250000", false, undefined, NaN, {}]) {
      const plan = snapshot({ budget: { amount: bad, currency: "INR", basis: "total" } });
      expect(codesOf(plan)).toContain("BUDGET_MISSING");
    }
    /* And a real zero is a recorded budget. */
    const zero = snapshot({ budget: { amount: 0, currency: "INR", basis: "total" } });
    expect(codesOf(zero)).not.toContain("BUDGET_MISSING");
    expect(readiness.evaluate({ plan: zero }).sections.locallyConfirmed.map((c) => c.code))
      .toContain("BUDGET_RECORDED");
  });

  test("a coercible currency or basis is missing", () => {
    for (const bad of [null, "", false, 0, 123]) {
      expect(codesOf(snapshot({ budget: { amount: 10, currency: bad, basis: "total" } })))
        .toContain("BUDGET_CURRENCY_MISSING");
      expect(codesOf(snapshot({ budget: { amount: 10, currency: "INR", basis: bad } })))
        .toContain("BUDGET_BASIS_MISSING");
    }
  });

  test("a non-string schedule, goal, identity or timezone is missing", () => {
    expect(codesOf(snapshot({ schedule: { startDate: 20261001, endDate: "2026-10-31" } })))
      .toContain("SCHEDULE_INCOMPLETE");
    expect(codesOf(snapshot({ schedule: { startDate: false, endDate: false } })))
      .toContain("SCHEDULE_INCOMPLETE");
    expect(codesOf(snapshot({ conversionGoal: 0 }))).toContain("CONVERSION_GOAL_MISSING");
    expect(codesOf(snapshot({ utmCampaign: false }))).toContain("TRACKING_IDENTITY_MISSING");

    const noTz = snapshot();
    noTz.deploymentBriefs[0].timezone = 0;
    expect(codesOf(noTz)).toContain("SCHEDULE_TIMEZONE_MISSING");
  });

  test("a creative made of non-strings is incomplete", () => {
    const plan = snapshot();
    /* Three entries, none of them text. A length check alone would have passed. */
    plan.deploymentBriefs[0].googleSearch = {
      headlines: [0, false, null], descriptions: [0, ""], keywordThemes: [false],
    };
    expect(codesOf(plan)).toContain("CREATIVE_INCOMPLETE");
  });

  test("a legacy snapshot with no brief fields at all is reported, not crashed", () => {
    const plan = snapshot({ deploymentBriefs: [{ channel: "google_ads" }] });
    const v = readiness.evaluate({ plan });
    expect(v.sections.missingFromPlan.map((f) => f.code)).toContain("CAMPAIGN_TYPE_MISSING");
    expect(v.planReady).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. THE DEPLOYMENT CONTRACT IS GENUINELY STRICT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the deployment record and its attempts", () => {
  const deploymentDoc = (over = {}) => ({
    companyId: A,
    campaignDraftId: new mongoose.Types.ObjectId(),
    draftRef: "MCP-2026-0001",
    approvedRevision: 3,
    channel: "google_ads",
    campaignType: "google_search",
    idempotencyKey: "deploy-key-00000001",
    state: "not_started",
    ...over,
  });

  const approver = () => ({
    id: new mongoose.Types.ObjectId(), name: "Ada", role: "admin", at: new Date(),
  });

  test("11. the channel and the campaign type cannot disagree", async () => {
    /* Both values are individually valid; the pair is nonsense. */
    await expect(MarketingCampaignDeployment.create(deploymentDoc({
      channel: "meta_ads", campaignType: "google_search",
    }))).rejects.toThrow(/campaign type and this deployment names/i);

    await expect(MarketingCampaignDeployment.create(deploymentDoc({
      channel: "google_ads", campaignType: "meta_traffic_single_image",
    }))).rejects.toThrow(/campaign type and this deployment names/i);

    /* And a matching pair is storable. */
    const ok = await MarketingCampaignDeployment.create(deploymentDoc());
    expect(ok.state).toBe("not_started");
    await MarketingCampaignDeployment.deleteMany({});
  });

  test("11b. only an advertising channel can be deployed to", async () => {
    for (const channel of ["email", "google_analytics"]) {
      await expect(MarketingCampaignDeployment.create(deploymentDoc({ channel })))
        .rejects.toThrow();
    }
    /* An unsupported campaign type is refused by the enum before the pairing check. */
    await expect(MarketingCampaignDeployment.create(deploymentDoc({ campaignType: "google_performance_max" })))
      .rejects.toThrow();
  });

  test("12. a consequential state needs an identifiable approver and a time", async () => {
    for (const state of ["preparing", "partially_created", "paused_confirmed", "failed", "activated"]) {
      /* No approver at all. */
      await expect(MarketingCampaignDeployment.create(deploymentDoc({ state })))
        .rejects.toThrow(/identifiable approver/i);

      /* A name but no id: a display snapshot is not an identity. */
      await expect(MarketingCampaignDeployment.create(deploymentDoc({
        state, deploymentApprovedBy: { name: "Ada", role: "admin", at: new Date() },
      }))).rejects.toThrow(/identifiable approver/i);

      /* An id but no time: an approval nobody can place against what the plan said. */
      await expect(MarketingCampaignDeployment.create(deploymentDoc({
        state, deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada" },
      }))).rejects.toThrow(/identifiable approver/i);
    }

    /* `not_started` is exempt, so the intent can be recorded before anybody
       authorises anything. */
    const intent = await MarketingCampaignDeployment.create(deploymentDoc());
    expect(intent.state).toBe("not_started");

    /* And a complete authorisation is accepted. */
    const authorised = await MarketingCampaignDeployment.create(deploymentDoc({
      state: "preparing",
      idempotencyKey: "deploy-key-00000002",
      deploymentApprovedBy: approver(),
    }));
    expect(authorised.state).toBe("preparing");
    await MarketingCampaignDeployment.deleteMany({});
  });

  test("14. submission and approval create no deployment and no attempt", async () => {
    const plan = await googlePlan();
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    await service.decide({ companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve" });
    await readinessOf(plan);

    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("13. repeated readiness reads write nothing", async () => {
    const plan = await googlePlan();
    const before = {
      drafts: await MarketingCampaignDraft.countDocuments({}),
      history: await MarketingCampaignDraftHistory.countDocuments({}),
      deployments: await MarketingCampaignDeployment.countDocuments({}),
      intents: await MarketingCampaignDeploymentAttemptIntent.countDocuments({}),
      results: await MarketingCampaignDeploymentAttemptResult.countDocuments({}),
    };

    for (let i = 0; i < 4; i += 1) await readinessOf(plan);

    expect({
      drafts: await MarketingCampaignDraft.countDocuments({}),
      history: await MarketingCampaignDraftHistory.countDocuments({}),
      deployments: await MarketingCampaignDeployment.countDocuments({}),
      intents: await MarketingCampaignDeploymentAttemptIntent.countDocuments({}),
      results: await MarketingCampaignDeploymentAttemptResult.countDocuments({}),
    }).toEqual(before);
  });

  test("the policy check no longer promises when a channel will decide", () => {
    const policy = readiness.EXTERNAL_CHECKS.find((c) => c.code === "EXTERNAL_POLICY_COMPATIBLE");
    /* The earlier wording said acceptance is decided after creation while paused.
       GRAV never verified that sequence, and a promise about somebody else's review
       process is not GRAV's to make. */
    expect(policy.action).not.toMatch(/after the campaign is created/i);
    expect(policy.action).not.toMatch(/while it is still paused/i);
    expect(policy.action).toMatch(/external check/i);
    expect(policy.action).toMatch(/cannot confirm it locally/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. A DEPLOYMENT ATTEMPT IS TWO APPEND-ONLY FACTS
   ═══════════════════════════════════════════════════════════════════════════

   The contradiction this resolves: a single immutable attempt row required its
   outcome, finish time, created objects and evidence at creation — facts that do not
   exist before the external request starts, and cannot be added afterwards to an
   immutable row. Writing it only after the request is worse: a crash mid-request
   leaves real advertising objects with no record that they exist. */

describe("an attempt is an intent before, and a result after", () => {
  const deploymentDoc = (over = {}) => ({
    companyId: A,
    campaignDraftId: new mongoose.Types.ObjectId(),
    draftRef: "MCP-2026-0001",
    approvedRevision: 3,
    channel: "google_ads",
    campaignType: "google_search",
    idempotencyKey: `deploy-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    state: "preparing",
    deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", role: "admin", at: new Date() },
    ...over,
  });

  const makeDeployment = (over = {}, company = null) => MarketingCampaignDeployment.create({
    ...deploymentDoc(over), ...(company ? { companyId: company } : {}),
  });

  /* ── A COMMAND IS THE SAME COMMAND ONLY IF ITS VALUES ARE ────────────────
     Stable identities and a stable authorisation time, because a retry now has to
     present the SAME command, not merely the same key. Generating a fresh id per
     call would make every "retry" a different command — which is exactly what the
     correction refuses. */
  const REQUESTER = { id: new mongoose.Types.ObjectId(), name: "Mo", role: "marketing" };
  const AUTHORISER = { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") };

  const beginArgs = (deployment, over = {}) => ({
    companyId: deployment.companyId,
    deploymentId: deployment._id,
    commandKey: "deploy-command-0001",
    approvedRevision: deployment.approvedRevision,
    channel: deployment.channel,
    campaignType: deployment.campaignType,
    requestedBy: { ...REQUESTER },
    authorizedBy: { ...AUTHORISER },
    plannedObjects: [{ role: "budget" }, { role: "campaign" }, { role: "advertisement" }],
    /* Written before the external request, so a process that dies mid-flight
       leaves behind the one string that can find what it may have created. */
    deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    ...over,
  });

  test("1. an intent can be recorded with no outcome at all", async () => {
    const deployment = await makeDeployment();
    const { intent, created } = await attempts.begin(beginArgs(deployment));

    expect(created).toBe(true);
    expect(intent.attemptNo).toBe(1);
    expect(intent.startedAt).toBeTruthy();
    expect(intent.plannedFingerprint).toBeTruthy();
    expect(intent.plannedSummary.objectCount).toBe(3);
    expect(intent.plannedSummary.objectRoles).toEqual(["advertisement", "budget", "campaign"]);

    /* ── AND IT IS STORABLE WITHOUT KNOWING THE FUTURE ──────────────────────
       The single-document version could not be written at this moment at all. */
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(1);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("2. an intent cannot carry a result-only field", async () => {
    const deployment = await makeDeployment();
    const stored = await MarketingCampaignDeploymentAttemptIntent.create({
      companyId: A, deploymentId: deployment._id, attemptNo: 1,
      commandKey: "k1", approvedRevision: 3, channel: "google_ads", campaignType: "google_search",
      requestedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
      authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
      plannedFingerprint: "abc",
      commandFingerprint: "def",
      deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
      /* Claimed outcome facts, offered to a record whose whole point is that it
         cannot know them yet. */
      outcome: "succeeded",
      finishedAt: new Date(),
      objects: [{ role: "campaign", providerObjectId: "1" }],
      deliveryObjectsNonDeliveringConfirmed: true,
    });

    /* Strict schema: the fields are not in it, so they are not stored. An intent
       that could carry a claimed outcome would let somebody record success before
       the request was made. */
    const raw = await MarketingCampaignDeploymentAttemptIntent.findById(stored._id).lean();
    expect(raw.outcome).toBeUndefined();
    expect(raw.finishedAt).toBeUndefined();
    expect(raw.objects).toBeUndefined();
    expect(raw.deliveryObjectsNonDeliveringConfirmed).toBeUndefined();
  });

  test("2b. an intent without a deployment marker is refused", async () => {
    const deployment = await makeDeployment();

    /* ── AN INTENT WITHOUT A MARKER RECORDS A PROBLEM AND NO WAY OUT OF IT ─
       Its whole job is to say "an external request is about to be made". A
       process that dies before the answer arrives then leaves a row saying
       something may exist in an advertising account, with nothing that could
       find out what — a campaign NAME cannot answer that question. */
    await expect(attempts.begin({ ...beginArgs(deployment), deploymentMarker: "" }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    const err = await attempts.begin({ ...beginArgs(deployment), deploymentMarker: undefined })
      .catch((e) => e);
    expect(err.message).toMatch(/so a lost response can be reconciled/i);

    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
  });

  test("3. a result cannot exist without a company-scoped intent", async () => {
    await expect(attempts.settle({
      companyId: A, intentId: new mongoose.Types.ObjectId(),
      outcome: "failed", reasonCode: "REFUSED",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("4. only one result may settle an intent", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));

    const first = await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED",
      objects: [{ role: "campaign", providerObjectId: "20481", origin: "created", deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: new Date(), observedState: "PAUSED" }],
    });
    expect(first.created).toBe(true);

    /* A second account of one attempt would make the record unreadable, and the
       first is the one written closest to the event. */
    await expect(attempts.settle({
      companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "CHANGED_MY_MIND",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);
    const stored = await MarketingCampaignDeploymentAttemptResult.findOne({}).lean();
    expect(stored.outcome).toBe("succeeded");
  });

  test("5. another company cannot settle it", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));

    await expect(attempts.settle({
      companyId: B, intentId: intent._id, outcome: "failed", reasonCode: "REFUSED",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);

    /* And company B sees nothing of A's attempt. */
    expect(await attempts.attemptsFor({ companyId: B, deploymentId: deployment._id })).toEqual([]);
  });

  test("6. a missing result is unknown — never failed, never safe to retry", async () => {
    const deployment = await makeDeployment();
    await attempts.begin(beginArgs(deployment));

    const [attempt] = await attempts.attemptsFor({ companyId: A, deploymentId: deployment._id });

    expect(attempt.resolved).toBe(false);
    expect(attempt.outcome).toBeNull();
    expect(attempt.finishedAt).toBeNull();

    /* ── THE SHAPE SAYS WHAT THE NULL MEANS ────────────────────────────────
       A bare null invites "nothing happened", which is the one reading that creates
       duplicate campaigns. */
    expect(attempt.means).toBe("GRAV recorded that this attempt started and does not yet know how it ended.");
    expect(attempt.mustNotBeReadAs).toEqual(["failed", "safe to retry", "proof that nothing was created"]);
    expect(attempt.requiresReconciliation).toBe(true);
    expect(attempt.reconciliationNote).toMatch(/may exist in the advertising account/i);
    expect(attempt.plannedSummary.objectCount).toBe(3);

    const outstanding = await attempts.hasUnresolvedAttempt({ companyId: A, deploymentId: deployment._id });
    expect(outstanding.unresolved).toBe(true);
    expect(outstanding.attempts).toHaveLength(1);
  });

  test("7. a successful result records every object, immutably", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));

    await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED",
      objects: [
        /* A budget is a money object. It has no status that says whether anything is
           being shown, so it is recorded with its identifier and asked nothing. */
        { role: "budget", providerObjectId: "900", origin: "created", deliveryStateApplies: false },
        { role: "campaign", providerObjectId: "901", origin: "created", deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: new Date(), observedState: "PAUSED" },
      ],
    });

    const [attempt] = await attempts.attemptsFor({ companyId: A, deploymentId: deployment._id });
    expect(attempt.resolved).toBe(true);
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.objects).toHaveLength(2);
    expect(attempt.deliveryObjectsNonDeliveringConfirmed).toBe(true);

    const [budget, campaign] = attempt.objects;
    /* ── THE BUDGET IS RECORDED, AND NOT FALSELY MARKED ──────────────────────
       Its identifier is kept, because an orphaned budget needs something pointing
       at it. Its delivery answer is null — not false, which would read as "we
       checked and it is running", and not true, which would be a fabrication. */
    expect(budget.providerObjectId).toBe("900");
    expect(budget.deliveryStateApplies).toBe(false);
    expect(budget.nonDeliveringConfirmed).toBeNull();
    expect(budget.stateReadAt).toBeNull();

    /* Read back, not assumed: a create returning 200 is not a stopped object. */
    expect(campaign.deliveryStateApplies).toBe(true);
    expect(campaign.nonDeliveringConfirmed).toBe(true);
    expect(campaign.stateReadAt).toBeTruthy();
    expect(campaign.observedState).toBe("PAUSED");

    const stored = await MarketingCampaignDeploymentAttemptResult.findOne({});
    await expect(MarketingCampaignDeploymentAttemptResult
      .updateOne({ _id: stored._id }, { $set: { "objects.1.nonDeliveringConfirmed": false } }))
      .rejects.toThrow(/append-only/i);
  });

  test("8. a partial result is distinct from a failure", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));

    await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "partially_created",
      reasonCode: "CHANNEL_UNAVAILABLE_MID_CREATION",
      operatorNote: "The budget was created. The campaign was not.",
      objects: [{ role: "budget", providerObjectId: "900", origin: "created", deliveryStateApplies: false }],
    });

    const [attempt] = await attempts.attemptsFor({ companyId: A, deploymentId: deployment._id });

    /* A failed attempt may have left nothing; a partial one certainly left
       something. Recording a partial as a failure invites a retry that duplicates. */
    expect(attempt.outcome).toBe("partially_created");
    expect(attempt.outcome).not.toBe("failed");
    expect(attempt.objects).toHaveLength(1);
    /* ── A BUDGET ALONE CONFIRMS NOTHING ────────────────────────────────────
       The one object created cannot deliver, so nothing has been confirmed
       non-delivering. The rollup says false, which is the honest answer: the
       campaign this budget was for was never created, and nobody has read the
       delivery state of anything. */
    expect(attempt.deliveryObjectsNonDeliveringConfirmed).toBe(false);
  });

  test("an empty object list confirms nothing", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));
    await attempts.settle({
      companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "REFUSED", objects: [],
    });

    const stored = await MarketingCampaignDeploymentAttemptResult.findOne({}).lean();
    /* `[].every(...)` is true, which would have made an attempt that created nothing
       report every delivery-capable object confirmed non-delivering. */
    expect(stored.deliveryObjectsNonDeliveringConfirmed).toBe(false);
  });

  test("an observed object is distinguished from a created one", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(beginArgs(deployment));

    /* A reconciliation that finds what a crashed attempt left behind is recording
       something it OBSERVED. Collapsing the two would make a recovery look like a
       deployment. */
    await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "partially_created", reasonCode: "RECONCILED_AFTER_CRASH",
      objects: [{ role: "campaign", providerObjectId: "555", origin: "observed", deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: new Date(), observedState: "PAUSED" }],
    });

    const stored = await MarketingCampaignDeploymentAttemptResult.findOne({}).lean();
    expect(stored.objects[0].origin).toBe("observed");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. BOTH FACTS ARE APPEND-ONLY, THROUGH EVERY MODEL PATH
   ═══════════════════════════════════════════════════════════════════════════ */

describe("neither fact can be rewritten", () => {
  const setup = async () => {
    const deployment = await MarketingCampaignDeployment.create({
      companyId: A,
      campaignDraftId: new mongoose.Types.ObjectId(),
      draftRef: "MCP-2026-0001", approvedRevision: 2,
      channel: "google_ads", campaignType: "google_search",
      idempotencyKey: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      state: "preparing",
      deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    });
    const { intent } = await attempts.begin({
      companyId: A, deploymentId: deployment._id, commandKey: "cmd-1",
      approvedRevision: 2, channel: "google_ads", campaignType: "google_search",
      requestedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
      authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") },
      plannedObjects: [{ role: "campaign" }],
      deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    });
    const { result } = await attempts.settle({
      companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "CHANNEL_UNAVAILABLE",
    });
    return { deployment, intent, result };
  };

  test("9. re-save, update, replace and delete are refused on both", async () => {
    const { intent, result } = await setup();

    for (const [Model, doc, label] of [
      [MarketingCampaignDeploymentAttemptIntent, intent, "intent"],
      [MarketingCampaignDeploymentAttemptResult, result, "result"],
    ]) {
      await expect(Model.updateOne({ _id: doc._id }, { $set: { companyId: B } })).rejects.toThrow(/append-only/i);
      await expect(Model.updateMany({}, { $set: { companyId: B } })).rejects.toThrow(/append-only/i);
      await expect(Model.findOneAndUpdate({ _id: doc._id }, { $set: { companyId: B } })).rejects.toThrow(/append-only/i);
      await expect(Model.replaceOne({ _id: doc._id }, { companyId: B })).rejects.toThrow(/append-only/i);
      await expect(Model.deleteOne({ _id: doc._id })).rejects.toThrow(/append-only/i);
      await expect(Model.deleteMany({})).rejects.toThrow(/append-only/i);
      await expect(Model.findOneAndDelete({ _id: doc._id })).rejects.toThrow(/append-only/i);

      const live = await Model.findById(doc._id);
      live.companyId = B;
      await expect(live.save()).rejects.toThrow(/append-only/i);
      expect(String(label)).toBeTruthy();
    }
  });

  test("9b. a bulk write containing a mutation is refused; one of pure inserts is not", async () => {
    const { intent, result } = await setup();

    /* ── THE PATH THE PREVIOUS VERSION MISSED ──────────────────────────────
       `bulkWrite` carries update, replace and delete operations and runs none of
       their hooks. One call could have rewritten an immutable row with nothing
       objecting. */
    for (const [Model, doc] of [
      [MarketingCampaignDeploymentAttemptIntent, intent],
      [MarketingCampaignDeploymentAttemptResult, result],
    ]) {
      for (const op of [
        { updateOne: { filter: { _id: doc._id }, update: { $set: { companyId: B } } } },
        { updateMany: { filter: {}, update: { $set: { companyId: B } } } },
        { replaceOne: { filter: { _id: doc._id }, replacement: { companyId: B } } },
        { deleteOne: { filter: { _id: doc._id } } },
        { deleteMany: { filter: {} } },
      ]) {
        await expect(Model.bulkWrite([op])).rejects.toThrow(/append-only/i);
      }

      /* Even when hidden among inserts. */
      await expect(Model.bulkWrite([
        { insertOne: { document: { companyId: A } } },
        { deleteMany: { filter: {} } },
      ])).rejects.toThrow(/append-only/i);
    }

    /* Insertion stays available: it is how an append-only fact is recorded. */
    const deployment = await MarketingCampaignDeployment.findOne({});
    const inserted = await MarketingCampaignDeploymentAttemptIntent.bulkWrite([
      {
        insertOne: {
          document: {
            companyId: A, deploymentId: deployment._id, attemptNo: 99,
            commandKey: "bulk-insert-1", approvedRevision: 2,
            channel: "google_ads", campaignType: "google_search",
            requestedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
            authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
            startedAt: new Date(), plannedFingerprint: "f", commandFingerprint: "g", deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
          },
        },
      },
    ]);
    expect(inserted.insertedCount).toBe(1);

    /* And nothing was altered. */
    const storedIntent = await MarketingCampaignDeploymentAttemptIntent.findById(intent._id).lean();
    expect(String(storedIntent.companyId)).toBe(String(A));
  });

  test("no Marketing service or route reaches these records through .collection", () => {
    const fs = require("fs");
    const path = require("path");

    /* Mongoose middleware cannot see `Model.collection.*`, so the model alone cannot
       close that path. The boundary that does is: every future write goes through
       the dedicated service, and nothing else touches the driver for these records.
       Asserted structurally, and NOT claimed to be stronger than it is. */
    const roots = [
      path.join(__dirname, "..", "..", "services", "marketing"),
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Marketing"),
    ];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });

    const files = roots.flatMap(walk).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(src).not.toMatch(/MarketingCampaignDeploymentAttempt\w*\s*\.\s*collection/);
      expect(src).not.toMatch(/MarketingCampaignDeployment\s*\.\s*collection/);
    }
  });

  test("the attempt service calls no provider and no HTTP client", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "marketing", "campaignDrafts", "deploymentAttempt.service.js"),
      "utf8",
    );
    /* The day recording an attempt and making the request live in one file is the
       day an exception between them leaves a campaign created and unrecorded. */
    for (const forbidden of [
      /require\(['"]axios['"]\)/,
      /require\([^)]*googleAdsClient/,
      /require\([^)]*metaAdsClient/,
      /require\([^)]*channelHttp/,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   15. ATTEMPT NUMBERS ARE ALLOCATED ATOMICALLY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("attempt numbering", () => {
  const makeDeployment = (company = null) => MarketingCampaignDeployment.create({
    companyId: company || A,
    campaignDraftId: new mongoose.Types.ObjectId(),
    draftRef: "MCP-2026-0001", approvedRevision: 1,
    channel: "meta_ads", campaignType: "meta_traffic_single_image",
    idempotencyKey: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    state: "preparing",
    deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
  });

  /* Stable, so a retry presents the same command and not merely the same key. */
  const REQUESTER = { id: new mongoose.Types.ObjectId(), name: "Mo" };
  const AUTHORISER = { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") };

  const args = (deployment, commandKey) => ({
    companyId: deployment.companyId, deploymentId: deployment._id, commandKey,
    approvedRevision: 1, channel: "meta_ads", campaignType: "meta_traffic_single_image",
    requestedBy: { ...REQUESTER },
    authorizedBy: { ...AUTHORISER },
    plannedObjects: [{ role: "campaign" }],
    deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
  });

  test("10. concurrent allocations produce different numbers", async () => {
    const deployment = await makeDeployment();

    const results = await Promise.all([
      attempts.begin(args(deployment, "cmd-a")),
      attempts.begin(args(deployment, "cmd-b")),
      attempts.begin(args(deployment, "cmd-c")),
    ]);

    const numbers = results.map((r) => r.intent.attemptNo).sort((x, y) => x - y);
    /* ── OUTCOME: three distinct numbers ────────────────────────────────────
       `count + 1` or "newest + 1" would have given two of them the same value, and
       the unique index would then have rejected one AFTER it may already have
       started an external request. */
    expect(numbers).toEqual([1, 2, 3]);
    expect(new Set(numbers).size).toBe(3);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(3);
  });

  test("11. one logical retry keeps its intent and its number", async () => {
    const deployment = await makeDeployment();

    const first = await attempts.begin(args(deployment, "same-command"));
    const retry = await attempts.begin(args(deployment, "same-command"));
    const third = await attempts.begin(args(deployment, "same-command"));

    expect(first.created).toBe(true);
    expect(first.disposition).toBe("new_intent");
    expect(retry.created).toBe(false);
    expect(retry.disposition).toBe("reconciliation_required");
    expect(third.created).toBe(false);
    expect(String(retry.intent._id)).toBe(String(first.intent._id));
    expect(retry.intent.attemptNo).toBe(first.intent.attemptNo);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(1);
  });

  test("11b. concurrent retries under one command identity produce one intent", async () => {
    const deployment = await makeDeployment();

    const results = await Promise.all([
      attempts.begin(args(deployment, "racing-command")),
      attempts.begin(args(deployment, "racing-command")),
    ]);

    const ids = new Set(results.map((r) => String(r.intent._id)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(1);

    /* ── A CONSUMED NUMBER MAY LEAVE A GAP ──────────────────────────────────
       The loser allocated a number and did not use it. An attempt number is an
       identity, not a count, and reclaiming one would let two attempts both be
       called the second. */
    const counter = await MarketingCampaignDeploymentAttemptCounter.findOne({}).lean();
    expect(counter.seq).toBeGreaterThanOrEqual(1);
  });

  test("numbering is per deployment and per company", async () => {
    const one = await makeDeployment();
    const two = await makeDeployment();
    const other = await makeDeployment(B);

    const a1 = await attempts.begin(args(one, "c1"));
    const a2 = await attempts.begin(args(one, "c2"));
    const b1 = await attempts.begin(args(two, "c1"));
    const c1 = await attempts.begin({ ...args(other, "c1"), companyId: B });

    expect([a1.intent.attemptNo, a2.intent.attemptNo]).toEqual([1, 2]);
    /* A second deployment starts again at 1, and so does another company's. */
    expect(b1.intent.attemptNo).toBe(1);
    expect(c1.intent.attemptNo).toBe(1);

    const counters = await MarketingCampaignDeploymentAttemptCounter.find({}).lean();
    expect(counters).toHaveLength(3);
    for (const counter of counters) {
      expect([String(A), String(B)]).toContain(String(counter.companyId));
    }
  });

  test("12. a crash after the intent leaves one honest unresolved attempt", async () => {
    const deployment = await makeDeployment();
    await attempts.begin(args(deployment, "crashing-command"));

    /* Nothing settles it — the process died mid-request. */
    const [attempt] = await attempts.attemptsFor({ companyId: A, deploymentId: deployment._id });
    expect(attempt.resolved).toBe(false);
    expect(attempt.requiresReconciliation).toBe(true);

    /* And a retry under the same command identity finds it rather than starting a
       second external request. It stays unresolved until somebody settles it. */
    const retry = await attempts.begin(args(deployment, "crashing-command"));
    expect(retry.created).toBe(false);
    expect(retry.intent.attemptNo).toBe(attempt.attemptNo);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(1);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);

    const outstanding = await attempts.hasUnresolvedAttempt({ companyId: A, deploymentId: deployment._id });
    expect(outstanding.unresolved).toBe(true);
  });

  test("13. a crash after the result leaves both facts and no duplicate on retry", async () => {
    const deployment = await makeDeployment();
    const { intent } = await attempts.begin(args(deployment, "settled-command"));
    await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED",
      objects: [{ role: "campaign", providerObjectId: "7", origin: "created", deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: new Date(), observedState: "PAUSED" }],
    });

    /* The caller never learned. Its retry finds both facts and adds nothing. */
    const retry = await attempts.begin(args(deployment, "settled-command"));
    expect(retry.created).toBe(false);
    /* A DIFFERENT account of the same attempt conflicts; the identical retry below
       is covered in the idempotency suite. */
    await expect(attempts.settle({
      companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "SOMETHING_ELSE",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(1);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);

    const [attempt] = await attempts.attemptsFor({ companyId: A, deploymentId: deployment._id });
    expect(attempt.resolved).toBe(true);
    expect(attempt.outcome).toBe("succeeded");
    expect(await attempts.hasUnresolvedAttempt({ companyId: A, deploymentId: deployment._id }))
      .toMatchObject({ unresolved: false });
  });

  test("the planned fingerprint is stable for one logical attempt", () => {
    const one = attempts.fingerprintOf([{ role: "campaign", name: "x" }, { role: "budget", amount: 5 }]);
    const two = attempts.fingerprintOf([{ name: "x", role: "campaign" }, { amount: 5, role: "budget" }]);
    const different = attempts.fingerprintOf([{ role: "campaign", name: "y" }, { role: "budget", amount: 5 }]);

    /* Order of properties is not a difference; a value is. */
    expect(one).toBe(two);
    expect(one).not.toBe(different);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   16. READINESS, SUBMISSION AND APPROVAL STILL RECORD NOTHING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nothing in the plan lifecycle creates a deployment, intent or result", () => {
  test("14. a full lifecycle plus repeated readiness reads leaves all three empty", async () => {
    const plan = await googlePlan();

    await readinessOf(plan);
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, expectedRevision: plan.revision });
    await readinessOf(plan);
    await service.decide({ companyId: A, user: ADMIN, campaignDraftId: plan.campaignDraftId, decision: "approve" });
    for (let i = 0; i < 3; i += 1) await readinessOf(plan);

    expect(await MarketingCampaignDeployment.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDeploymentAttemptCounter.countDocuments({})).toBe(0);
  });

  test("no plan service or route loads the attempt writer", () => {
    const fs = require("fs");
    const path = require("path");
    for (const parts of [
      ["services", "marketing", "campaignDrafts", "campaignDraft.service.js"],
      ["services", "marketing", "campaignDrafts", "deploymentReadiness.service.js"],
      ["routes", "CMS_Routes", "Marketing", "campaignDrafts.js"],
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");
      expect(src).not.toMatch(/deploymentAttempt\.service/);
      expect(src).not.toMatch(/MarketingCampaignDeploymentAttempt/);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   17. A COMMAND KEY NAMES A COMMAND, NOT JUST AN ATTEMPT
   ═══════════════════════════════════════════════════════════════════════════

   `begin` looked an intent up by key and returned it. The same key could then be
   reused with a different approved revision, channel, campaign type, planned
   objects, requester or authorisation and be accepted as a retry — handing back an
   intent that describes something else, and authorising an external request nobody
   recorded. */

describe("a retry must present the same command, not merely the same key", () => {
  let deployment;
  const REQUESTER = { id: new mongoose.Types.ObjectId(), name: "Mo", role: "marketing" };
  const AUTHORISER = { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") };

  const command = (over = {}) => ({
    companyId: A,
    deploymentId: deployment._id,
    commandKey: "one-command-identity",
    approvedRevision: 4,
    channel: "google_ads",
    campaignType: "google_search",
    requestedBy: { ...REQUESTER },
    authorizedBy: { ...AUTHORISER },
    plannedObjects: [{ role: "budget" }, { role: "campaign" }],
    deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    ...over,
  });

  beforeEach(async () => {
    deployment = await MarketingCampaignDeployment.create({
      companyId: A,
      campaignDraftId: new mongoose.Types.ObjectId(),
      draftRef: "MCP-2026-0001", approvedRevision: 4,
      channel: "google_ads", campaignType: "google_search",
      idempotencyKey: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      state: "preparing",
      deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    });
  });

  const counts = async () => ({
    intents: await MarketingCampaignDeploymentAttemptIntent.countDocuments({}),
    results: await MarketingCampaignDeploymentAttemptResult.countDocuments({}),
    counters: await MarketingCampaignDeploymentAttemptCounter.countDocuments({}),
    seq: (await MarketingCampaignDeploymentAttemptCounter.findOne({}).lean())?.seq ?? 0,
  });

  test("1. the same key with an identical command returns the same intent", async () => {
    const first = await attempts.begin(command());
    const again = await attempts.begin(command());

    expect(String(again.intent._id)).toBe(String(first.intent._id));
    expect(again.intent.attemptNo).toBe(first.intent.attemptNo);
    expect(again.created).toBe(false);
    expect(await counts()).toMatchObject({ intents: 1, seq: 1 });
  });

  test("2. the same key with a changed command conflicts, and writes nothing", async () => {
    await attempts.begin(command());
    const before = await counts();

    const variations = [
      ["approved revision", { approvedRevision: 5 }],
      ["channel and type", { channel: "meta_ads", campaignType: "meta_traffic_single_image" }],
      ["planned objects", { plannedObjects: [{ role: "budget" }] }],
      ["requester", { requestedBy: { id: new mongoose.Types.ObjectId(), name: "Someone else" } }],
      ["authorisation identity", { authorizedBy: { ...AUTHORISER, id: new mongoose.Types.ObjectId() } }],
      ["authorisation time", { authorizedBy: { ...AUTHORISER, at: new Date("2026-09-13T11:00:00Z") } }],
    ];

    for (const [what, over] of variations) {
      let caught = null;
      try { await attempts.begin(command(over)); } catch (err) { caught = err; }

      expect(caught?.code).toBe("CONFLICT");
      expect(caught.message).toMatch(/already used for a different attempt/i);
      expect(String(what)).toBeTruthy();
    }

    /* ── NO NUMBER ALLOCATED, NOTHING WRITTEN ───────────────────────────────
       The counter is untouched, so a refused command does not even spend an attempt
       number. */
    expect(await counts()).toEqual(before);
  });

  test("2b. a malformed retry is refused on its own merits, key or no key", async () => {
    await attempts.begin(command());
    const before = await counts();

    /* Validation runs BEFORE the lookup, so a nonsense command cannot be waved
       through because its key happens to exist. */
    for (const over of [
      { approvedRevision: 0 },
      { approvedRevision: "4" },
      { channel: "email", campaignType: "google_search" },
      { campaignType: "google_performance_max" },
      { requestedBy: { name: "No id" } },
      { authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada" } },
      { plannedObjects: [] },
      { plannedObjects: [{ role: "nonsense" }] },
    ]) {
      await expect(attempts.begin(command(over))).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(await counts()).toEqual(before);
  });

  test("a genuinely different command under a NEW key takes the next number", async () => {
    const first = await attempts.begin(command());
    const second = await attempts.begin(command({
      commandKey: "a-second-identity", approvedRevision: 5,
    }));

    expect(second.intent.attemptNo).toBe(first.intent.attemptNo + 1);
    expect(second.created).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   18. ONLY ONE DISPOSITION AUTHORISES AN EXTERNAL CALL
   ═══════════════════════════════════════════════════════════════════════════ */

describe("begin says whether a provider may be called", () => {
  let deployment;
  const REQUESTER = { id: new mongoose.Types.ObjectId(), name: "Mo" };
  const AUTHORISER = { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") };

  const command = (over = {}) => ({
    companyId: A, deploymentId: deployment._id, commandKey: "disposition-command",
    approvedRevision: 2, channel: "google_ads", campaignType: "google_search",
    requestedBy: { ...REQUESTER }, authorizedBy: { ...AUTHORISER },
    plannedObjects: [{ role: "campaign" }],
    deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    ...over,
  });

  beforeEach(async () => {
    deployment = await MarketingCampaignDeployment.create({
      companyId: A, campaignDraftId: new mongoose.Types.ObjectId(),
      draftRef: "MCP-2026-0001", approvedRevision: 2,
      channel: "google_ads", campaignType: "google_search",
      idempotencyKey: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      state: "preparing",
      deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    });
  });

  test("5. only a newly recorded intent may call a provider", async () => {
    const first = await attempts.begin(command());

    expect(first.disposition).toBe("new_intent");
    expect(first.mayCallProvider).toBe(true);
    expect(first.created).toBe(true);
    expect(first.reason).toMatch(/nothing external has happened/i);
  });

  test("3. an unresolved retry may NOT call a provider", async () => {
    await attempts.begin(command());
    const retry = await attempts.begin(command());

    /* ── THE CORRECTION ──────────────────────────────────────────────────────
       Returning the intent used to be the whole answer, leaving a caller to
       separately read `hasUnresolvedAttempt` and race against it. The previous
       outcome is unknown; calling again is how a second set of objects is made. */
    expect(retry.disposition).toBe("reconciliation_required");
    expect(retry.mayCallProvider).toBe(false);
    expect(retry.reason).toMatch(/does not know how it ended/i);
    expect(retry.reason).toMatch(/reconciled/i);
  });

  test("4. a settled retry may NOT call a provider", async () => {
    const { intent } = await attempts.begin(command());
    await attempts.settle({
      companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "CHANNEL_UNAVAILABLE",
    });

    const retry = await attempts.begin(command());
    expect(retry.disposition).toBe("already_settled");
    expect(retry.mayCallProvider).toBe(false);
    expect(retry.reason).toMatch(/already settled as failed/i);
  });

  test("the disposition comes from one read, not two", async () => {
    /* Every answer carries the flag, so a caller never has to ask a second question
       whose answer can change in between. */
    const first = await attempts.begin(command());
    const second = await attempts.begin(command());
    for (const out of [first, second]) {
      expect(typeof out.mayCallProvider).toBe("boolean");
      expect(["new_intent", "reconciliation_required", "already_settled"]).toContain(out.disposition);
      expect(out.reason.length).toBeGreaterThan(0);
    }
    expect([first, second].filter((o) => o.mayCallProvider)).toHaveLength(1);
  });

  test("the service documents that only mayCallProvider true authorises a call", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "marketing", "campaignDrafts", "deploymentAttempt.service.js"),
      "utf8",
    );
    /* Structural: the rule is written where a future writer will read it, beside the
       thing it governs. */
    expect(src).toMatch(/mayCallProvider/);
    expect(src).toMatch(/true for exactly one disposition/i);
    expect(src).toMatch(/does NOT authorise another external call/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   19. SETTLEMENT IS IDEMPOTENT, AND INVENTS NO EVIDENCE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("settling an attempt", () => {
  let deployment;
  let intent;

  const stopped = (id, over = {}) => ({
    role: "campaign", providerObjectId: id, origin: "created",
    deliveryStateApplies: true, nonDeliveringConfirmed: true,
    stateReadAt: new Date("2026-09-13T09:10:00Z"),
    observedState: "PAUSED", ...over,
  });

  beforeEach(async () => {
    deployment = await MarketingCampaignDeployment.create({
      companyId: A, campaignDraftId: new mongoose.Types.ObjectId(),
      draftRef: "MCP-2026-0001", approvedRevision: 1,
      channel: "google_ads", campaignType: "google_search",
      idempotencyKey: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      state: "preparing",
      deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    });
    ({ intent } = await attempts.begin({
      companyId: A, deploymentId: deployment._id, commandKey: "settle-command",
      approvedRevision: 1, channel: "google_ads", campaignType: "google_search",
      requestedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
      authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") },
      plannedObjects: [{ role: "campaign" }],
      deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    }));
  });

  test("6. an identical settlement retry returns the existing result", async () => {
    const settlement = () => ({
      companyId: A, intentId: intent._id,
      outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED",
      operatorNote: "One campaign, paused.",
      objects: [stopped("20481")],
    });

    const first = await attempts.settle(settlement());
    /* A second later, so the generated finish time differs — which must not make
       this look like a different settlement. */
    const again = await attempts.settle({ ...settlement(), now: new Date(Date.now() + 1000) });

    expect(first.created).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(again.created).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(String(again.result._id)).toBe(String(first.result._id));
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);
  });

  test("7. a different settlement for the same intent conflicts", async () => {
    await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED", objects: [stopped("20481")],
    });

    for (const different of [
      { outcome: "failed", reasonCode: "CREATED_AND_PAUSED", objects: [] },
      { outcome: "succeeded", reasonCode: "A_DIFFERENT_REASON", objects: [stopped("20481")] },
      { outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED", objects: [stopped("99999")] },
      { outcome: "succeeded", reasonCode: "CREATED_AND_PAUSED", operatorNote: "Different note.", objects: [stopped("20481")] },
    ]) {
      await expect(attempts.settle({ companyId: A, intentId: intent._id, ...different }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    }

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(1);
    const stored = await MarketingCampaignDeploymentAttemptResult.findOne({}).lean();
    expect(stored.outcome).toBe("succeeded");
  });

  test("8. a missing origin or an invented state read is refused", async () => {
    /* ── NO DEFAULT MAY MANUFACTURE EVIDENCE ────────────────────────────────
       `origin` defaulted to `created`, so an object a reconciliation merely found
       was recorded as one GRAV made. The confirmation time defaulted to now, so a
       confirmation carried a timestamp for a read that never happened. */
    const D = { deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: new Date() };
    const cases = [
      [{ role: "campaign", providerObjectId: "1", ...D }, /created it or merely observed/i],
      [{ role: "campaign", providerObjectId: "1", origin: "invented", ...D }, /created it or merely observed/i],
      [{ role: "campaign", providerObjectId: "1", origin: "created", deliveryStateApplies: true, nonDeliveringConfirmed: true }, /needs the time its state was read/i],
      [{ role: "campaign", providerObjectId: "1", origin: "created", deliveryStateApplies: true, nonDeliveringConfirmed: true, stateReadAt: "not a date" }, /needs the time its state was read/i],
      [{ role: "campaign", providerObjectId: "1", origin: "created", deliveryStateApplies: true }, /read back as not delivering/i],

      /* ── AND NOTHING MAY BE CLAIMED ABOUT A STATE AN OBJECT HAS NOT GOT ───
         A budget cannot be reported as delivering, as not delivering, or as read
         at a particular time. All three are answers to a question it has no
         answer to. */
      [{ role: "budget", providerObjectId: "1", origin: "created" }, /whether a delivery state applies/i],
      [{ role: "budget", providerObjectId: "1", origin: "created", deliveryStateApplies: "yes" }, /whether a delivery state applies/i],
      [{ role: "budget", providerObjectId: "1", origin: "created", deliveryStateApplies: false, nonDeliveringConfirmed: false }, /cannot be recorded as delivering or not delivering/i],
      [{ role: "budget", providerObjectId: "1", origin: "created", deliveryStateApplies: false, nonDeliveringConfirmed: true }, /cannot be recorded as delivering or not delivering/i],
      [{ role: "budget", providerObjectId: "1", origin: "created", deliveryStateApplies: false, stateReadAt: new Date() }, /no state read to timestamp/i],

      [{ role: "campaign", origin: "created", ...D }, /identifier the channel gave it/i],
    ];

    for (const [object, message] of cases) {
      let caught = null;
      try {
        await attempts.settle({
          companyId: A, intentId: intent._id,
          outcome: "partially_created", reasonCode: "X", objects: [object],
        });
      } catch (err) { caught = err; }
      expect(caught?.code).toBe("VALIDATION");
      expect(caught.message).toMatch(message);
    }

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("9. an outcome that disagrees with its evidence is refused", async () => {
    const settle = (over) => attempts.settle({
      companyId: A, intentId: intent._id, reasonCode: "X", ...over,
    });

    /* A success nobody can point at. */
    await expect(settle({ outcome: "succeeded", objects: [] }))
      .rejects.toThrow(/success nobody can point at/i);

    /* A success with an object that was never read back as stopped: it may be able
       to deliver, and calling that success hides it. */
    await expect(settle({
      outcome: "succeeded",
      objects: [stopped("1", { nonDeliveringConfirmed: false, stateReadAt: null, observedState: "ENABLED" })],
    })).rejects.toThrow(/confirmed not delivering/i);

    /* ── A SUCCESS MADE ONLY OF SUPPORTING OBJECTS ──────────────────────────
       Every object confirmed, vacuously, because none of them can deliver. The old
       rollup said "all paused" here; a budget with no campaign is not a deployed
       campaign, and this must not pass as success. */
    await expect(settle({
      outcome: "succeeded",
      objects: [{ role: "budget", providerObjectId: "900", origin: "created", deliveryStateApplies: false }],
    })).rejects.toThrow(/Supporting objects alone confirm nothing/i);

    /* A partial with nothing partial about it. */
    await expect(settle({ outcome: "partially_created", objects: [] }))
      .rejects.toThrow(/it is a failure, not a partial one/i);

    /* A partial that is indistinguishable from complete success would send somebody
       to reconcile an account where nothing is outstanding. */
    await expect(settle({ outcome: "partially_created", objects: [stopped("1"), stopped("2")] }))
      .rejects.toThrow(/complete success rather than a partial one/i);

    /* Refused at preflight means nothing external happened. */
    await expect(settle({ outcome: "refused_preflight", objects: [stopped("1")] }))
      .rejects.toThrow(/carries no external objects/i);

    /* An unknown outcome, and a settlement with no reason code. */
    await expect(settle({ outcome: "probably_fine", objects: [] })).rejects.toThrow(/An outcome must be one of/i);
    await expect(attempts.settle({ companyId: A, intentId: intent._id, outcome: "failed", reasonCode: "" }))
      .rejects.toThrow(/needs a GRAV reason code/i);

    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({})).toBe(0);
  });

  test("9b. a failure may carry the objects it created, and a partial is accepted", async () => {
    /* ── A FAILURE MUST NOT HIDE WHAT IT MADE ───────────────────────────────
       A failure that created a budget and then stopped has left an orphan in an
       advertising account. Refusing to record it is how nothing points at it. */
    const failed = await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "failed", reasonCode: "CHANNEL_UNAVAILABLE_MID_CREATION",
      objects: [{ role: "budget", providerObjectId: "900", origin: "created", deliveryStateApplies: false }],
    });
    expect(failed.result.objects).toHaveLength(1);
    expect(failed.result.objects[0].providerObjectId).toBe("900");
    expect(failed.result.deliveryObjectsNonDeliveringConfirmed).toBe(false);
  });

  test("a partial with one stopped and one not is accepted and recorded honestly", async () => {
    const out = await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "partially_created", reasonCode: "STOPPED_MID_CREATION",
      objects: [
        { role: "budget", providerObjectId: "900", origin: "created", deliveryStateApplies: false },
        stopped("901"),
        stopped("902", { nonDeliveringConfirmed: false, stateReadAt: null, observedState: "ENABLED" }),
      ],
    });
    expect(out.result.outcome).toBe("partially_created");
    /* One delivery-capable object is still able to deliver, so the rollup is false
       even though another was confirmed. */
    expect(out.result.deliveryObjectsNonDeliveringConfirmed).toBe(false);
    expect(out.result.objects.map((o) => o.deliveryStateApplies)).toEqual([false, true, true]);
    expect(out.result.objects.map((o) => o.nonDeliveringConfirmed)).toEqual([null, true, false]);
  });

  test("a partial made only of OBSERVED objects is accepted", async () => {
    /* A reconciliation that finds what a crash left behind: every object confirmed
       paused, none of them created by this attempt. That is not complete success. */
    const out = await attempts.settle({
      companyId: A, intentId: intent._id,
      outcome: "partially_created", reasonCode: "RECONCILED_AFTER_CRASH",
      objects: [stopped("555", { origin: "observed" })],
    });
    expect(out.result.objects[0].origin).toBe("observed");
  });

  test("10. company isolation and concurrent allocation are unchanged", async () => {
    /* Another company cannot settle this intent, whatever it sends. */
    await expect(attempts.settle({
      companyId: B, intentId: intent._id, outcome: "failed", reasonCode: "X",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    /* And concurrent commands on one deployment still receive distinct numbers. */
    const shared = {
      companyId: A, deploymentId: deployment._id,
      approvedRevision: 1, channel: "google_ads", campaignType: "google_search",
      requestedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
      authorizedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date("2026-09-13T09:00:00Z") },
      plannedObjects: [{ role: "campaign" }],
      deploymentMarker: "GRAV-D1-00000000000000000000000000000001",
    };
    const out = await Promise.all([
      attempts.begin({ ...shared, commandKey: "concurrent-a" }),
      attempts.begin({ ...shared, commandKey: "concurrent-b" }),
      attempts.begin({ ...shared, commandKey: "concurrent-c" }),
    ]);
    const numbers = out.map((o) => o.intent.attemptNo).sort((x, y) => x - y);
    /* 1 was taken by the intent this suite sets up. */
    expect(numbers).toEqual([2, 3, 4]);
    expect(new Set(numbers).size).toBe(3);

    /* Company B has nothing. */
    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({ companyId: B })).toBe(0);
    expect(await attempts.attemptsFor({ companyId: B, deploymentId: deployment._id })).toEqual([]);
  });
});
