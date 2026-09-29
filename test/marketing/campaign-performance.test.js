// test/marketing/campaign-performance.test.js
//
// WHAT A CAMPAIGN DID, WITHOUT INVENTING A SINGLE NUMBER.
//
// ── EVERY TEST HERE IS THE SAME TEST ───────────────────────────────────────
// A reporting feature fails in one shape: a figure that looks real and is not.
// A missing metric rendered as zero. A half-counted day summed into a month. A
// click-through rate divided by zero impressions. Two currencies added
// together. Each of those produces a number somebody will act on, and none of
// them looks wrong on a screen.
//
// So most of what follows is about absence — proving that when GRAV does not
// know something, it says so, and that the saying-so survives all the way to
// the response.
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
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignObservation,
  MarketingCampaignObservationRevision,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const Binding = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding");

const sync = require("../../services/marketing/performance/observationSync.service");
const reportService = require("../../services/marketing/performance/campaignReport.service");
const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const binding = require("../../services/marketing/deployment/accountBinding.service");
const { fail } = require("../../services/storePurchase/errors");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

const GOOGLE_ACCOUNT = "1234567890";
const META_ACCOUNT = "act_9876543210";

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
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignPerformance"));
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

const call = async (p, { user = MARKETER, method = "GET", body = null, company = null } = {}) => {
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

/* ═══════════════════════════════════════════════════════════════════════════
   A FIXED CALENDAR
   ───────────────────────────────────────────────────────────────────────────
   Completeness depends on what "today" is in the account's timezone, so these
   tests pin it. Without that, a suite passing in the morning fails in the
   evening when a day rolls over — and the bug it would be hiding is exactly
   the one this feature exists to prevent.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── DERIVED FROM THE REAL CLOCK, NOT PINNED TO A DATE ─────────────────────
   Completeness depends on what "today" is in the account's timezone. A
   hard-coded date would make this suite pass this week and fail next — and the
   bug it would then be hiding is exactly the one the feature exists to prevent.
   Every window below is expressed relative to today instead. */
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/* Comfortably outside the settling window, so these are `complete`. */
const SETTLED_FROM = DAY(-10);
const SETTLED_TO = DAY(-5);

afterEach(() => jest.restoreAllMocks());

/* ═══════════════════════════════════════════════════════════════════════════
   FAKES
   ═══════════════════════════════════════════════════════════════════════════ */

const googleDay = (date, over = {}) => ({
  date,
  impressions: 1000,
  clicks: 40,
  costMicros: 1234567,
  conversions: 2,
  conversionValue: null,
  reach: null,
  landingPageViews: null,
  ...over,
});

const metaDay = (date, over = {}) => ({
  date,
  impressions: 2000,
  reach: 1500,
  clicks: 60,
  landingPageViews: 45,
  spend: 12.34,
  conversions: 3,
  conversionValue: 900,
  conversionActionTypes: ["lead"],
  ...over,
});

const fakeGoogle = (days, over = {}) => ({
  campaignDailyReport: jest.fn(async () => ({ currency: "INR", days, rowsRead: days.length })),
  ...over,
});

const fakeMeta = (days, over = {}) => ({
  campaignDailyInsights: jest.fn(async () => ({ currency: "INR", days, rowsRead: days.length })),
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES
   ═══════════════════════════════════════════════════════════════════════════ */

const PLAN = Object.freeze({
  name: "Winter uniforms",
  objective: "lead_generation",
  channels: ["google_ads"],
  startDate: "2026-09-01",
  endDate: "2026-12-15",
  budgetAmount: 2500,
  budgetCurrency: "INR",
  budgetBasis: "daily",
  conversionGoal: "form_submission",
});

async function makePlan(channels = ["google_ads"]) {
  const created = await drafts.create({
    companyId: A, user: MARKETER,
    payload: {
      ...PLAN, channels, utmCampaign: fresh("winter"), idempotencyKey: fresh("k"),
    },
  });
  return drafts.loadForDeployment({ companyId: A, campaignDraftId: created.campaignDraftId });
}

/* A deployment record with an external campaign, written directly — this suite
   is about reporting, and driving the whole creation path to get one would
   couple it to a protocol it is not testing. */
async function makeDeployment(plan, { channel = "google_ads", campaignId = "3001", currency = "INR", company = null } = {}) {
  return MarketingCampaignDeployment.create({
    companyId: company || A,
    campaignDraftId: plan._id,
    draftRef: plan.draftRef,
    approvedRevision: plan.revision,
    channel,
    campaignType: channel === "google_ads" ? "google_search" : "meta_traffic_single_image",
    idempotencyKey: fresh("dep"),
    state: "paused_confirmed",
    deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    externalObjects: [{
      role: "campaign",
      providerObjectId: campaignId,
      deliveryStateApplies: true,
      nonDeliveringConfirmed: true,
      stateReadAt: new Date(),
      observedState: "PAUSED",
      createdAt: new Date(),
    }],
    ...(currency ? {} : {}),
  });
}

async function bindAccount({ channel = "google_ads", currency = "INR", company = null } = {}) {
  const account = channel === "google_ads" ? GOOGLE_ACCOUNT : META_ACCOUNT;
  return Binding.create({
    companyId: company || A,
    channel,
    externalAccountId: channel === "google_ads" ? account : account,
    externalAccountName: "Test account",
    currency,
    timeZone: "Asia/Kolkata",
    state: "verified",
    boundBy: { id: new mongoose.Types.ObjectId(), name: "Ada" },
    lastVerification: { at: new Date(), outcome: "reachable", reasonCode: "" },
  });
}

/* Run a sync with the clock pinned. `todayIn` is module-internal, so the window
   is chosen to sit entirely in the settled past and the assertion is on the
   completeness the service derives from its own clock. */
const syncWindow = (deployment, deps, { from = SETTLED_FROM, to = SETTLED_TO } = {}) => sync.sync({
  companyId: A, deploymentId: deployment._id, startDate: from, endDate: to,
}, deps);

const reportFor = (plan, over = {}) => reportService.report({
  companyId: A, campaignDraftId: plan._id, draftRef: plan.draftRef,
  startDate: SETTLED_FROM, endDate: SETTLED_TO, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1–4. TWO CHANNELS, ONE VOCABULARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("normalising two channels into one shape", () => {
  test("1. Google and Meta produce the same response structure", async () => {
    const googlePlan = await makePlan(["google_ads"]);
    const gDep = await makeDeployment(googlePlan, { channel: "google_ads" });
    await bindAccount({ channel: "google_ads" });

    const metaPlan = await makePlan(["meta_ads"]);
    const mDep = await makeDeployment(metaPlan, { channel: "meta_ads", campaignId: "9001" });
    await bindAccount({ channel: "meta_ads" });

    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(gDep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });
    await syncWindow(mDep, { metaAds: fakeMeta(days.map((d) => metaDay(d))) });

    const g = await reportFor(googlePlan);
    const m = await reportFor(metaPlan);

    /* ── THE SAME KEYS, WHICHEVER CHANNEL ────────────────────────────────
       Lane B renders one component, and the intelligence layer later consumes
       one shape. A structure that differed per channel would push that
       difference into every consumer. */
    const shapeOf = (r) => ({
      deployment: Object.keys(r.deployments[0]).sort(),
      totals: Object.keys(r.deployments[0].totals).sort(),
      derived: r.deployments[0].derived.map((d) => d.code),
      day: Object.keys(r.deployments[0].daily[0]).sort(),
    });
    expect(shapeOf(g)).toEqual(shapeOf(m));

    /* And the figures are each channel's own, normalised. */
    expect(g.deployments[0].channel).toBe("google_ads");
    expect(g.deployments[0].totals.impressions).toBe(1000 * days.length);
    expect(m.deployments[0].totals.impressions).toBe(2000 * days.length);

    /* ── WHAT ONE CHANNEL DOES NOT REPORT STAYS ABSENT ────────────────────
       Google reports no reach and no landing-page views on a Search campaign.
       Zero would say nobody saw a campaign its own impressions contradict. */
    expect(g.deployments[0].totals.reach).toBeNull();
    expect(g.deployments[0].totals.landingPageViews).toBeNull();
    expect(m.deployments[0].totals.reach).toBe(1500);
    expect(m.deployments[0].totals.landingPageViews).toBe(45 * days.length);
  });

  test("2. a genuine zero stays zero, and a missing figure stays missing", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();

    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    /* ── A DAY THE CHANNEL REPORTED AS ZERO ───────────────────────────────
       The campaign ran and spent nothing. That is a fact, and it must survive
       as 0 — a null here would make a real "we spent nothing" look like a gap. */
    await syncWindow(dep, {
      googleAds: fakeGoogle(days.map((d) => googleDay(d, {
        impressions: 0, clicks: 0, costMicros: 0, conversions: 0,
      }))),
    });

    const zero = await reportFor(plan);
    expect(zero.deployments[0].totals.spendMinorUnits).toBe(0);
    expect(zero.deployments[0].totals.impressions).toBe(0);
    expect(zero.deployments[0].totals.clicks).toBe(0);

    /* ── AND A DAY THE CHANNEL DID NOT REPORT SPEND FOR ───────────────────
       `null`, not 0. These two totals must never be the same number. */
    await MarketingCampaignObservation.deleteMany({ companyId: A });
    await syncWindow(dep, {
      googleAds: fakeGoogle(days.map((d) => googleDay(d, { costMicros: null, conversions: null }))),
    });

    const missing = await reportFor(plan);
    expect(missing.deployments[0].totals.spendMinorUnits).toBeNull();
    expect(missing.deployments[0].totals.conversions).toBeNull();
    /* The metrics the channel DID report are unaffected. */
    expect(missing.deployments[0].totals.impressions).toBe(1000 * days.length);

    /* And the stored row keeps the distinction too — this is not a presentation
       trick. */
    const row = await MarketingCampaignObservation.findOne({ companyId: A }).lean();
    expect(row.spendMicros).toBeNull();
    expect(row.impressions).toBe(1000);
  });

  test("3. spend is kept exactly and rounded once", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    /* ── A FRACTION OF A PAISA PER DAY IS A REAL DISCREPANCY ──────────────
       Google reports micros. 1_234_567 micros is 123.4567 minor units.
       Rounding each day and then adding loses up to half a minor unit per day;
       summing in micros and rounding once does not. */
    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d, { costMicros: 1234567 }))) });

    const row = await MarketingCampaignObservation.findOne({ companyId: A }).lean();
    expect(row.spendMicros).toBe(1234567);
    expect(row.spendMinorUnits).toBe(123);

    const out = await reportFor(plan);
    const exact = Math.round((1234567 * days.length) / 10000);
    expect(out.deployments[0].totals.spendMinorUnits).toBe(exact);
    /* Which is NOT the same as rounding per day and adding. */
    expect(exact).not.toBe(123 * days.length);
  });

  test("4. Meta's conversion definition travels with its figure", async () => {
    const plan = await makePlan(["meta_ads"]);
    const dep = await makeDeployment(plan, { channel: "meta_ads", campaignId: "9001" });
    await bindAccount({ channel: "meta_ads" });
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, { metaAds: fakeMeta(days.map((d) => metaDay(d))) });
    const out = await reportFor(plan);

    /* ── EACH CHANNEL DECIDES WHAT A CONVERSION IS ────────────────────────
       A reader who disagrees with the definition can see it instead of
       guessing, and the two channels' figures are never silently added. */
    expect(out.deployments[0].conversionBasis.countedTypes).toContain("lead");
    expect(out.deployments[0].conversionBasis.means).toMatch(/Not every tracked action/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5–8. THE FOUR WAYS A REPORT LIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what the report refuses to say", () => {
  test("5. zero impressions produces no click-through rate, not a rate of zero", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, {
      googleAds: fakeGoogle(days.map((d) => googleDay(d, {
        impressions: 0, clicks: 0, costMicros: 0, conversions: 0,
      }))),
    });

    const out = await reportFor(plan);
    const ctr = out.deployments[0].derived.find((d) => d.code === "ctr");

    /* ── A DIVISION BY ZERO DRESSED UP AS A PERCENTAGE ────────────────────
       "0% click-through" tells a marketer the creative is failing. The truth is
       the campaign was never shown, and those lead to opposite decisions. */
    expect(ctr.available).toBe(false);
    expect(ctr.value).toBeNull();
    expect(ctr.why).toMatch(/was not shown/i);

    const cpc = out.deployments[0].derived.find((d) => d.code === "cpc");
    expect(cpc.available).toBe(false);
    expect(cpc.why).toMatch(/Nobody clicked/i);

    const cpa = out.deployments[0].derived.find((d) => d.code === "cpa");
    expect(cpa.available).toBe(false);
    expect(cpa.why).toMatch(/Nothing converted/i);
  });

  test("6. a ratio whose input nobody reported is absent, and says which input", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, {
      googleAds: fakeGoogle(days.map((d) => googleDay(d, { costMicros: null }))),
    });

    const out = await reportFor(plan);
    const cpc = out.deployments[0].derived.find((d) => d.code === "cpc");
    expect(cpc.available).toBe(false);
    expect(cpc.why).toMatch(/does not know the spent/i);

    /* The ratio whose inputs ARE known still works — one missing metric does
       not silence the whole report. */
    const ctr = out.deployments[0].derived.find((d) => d.code === "ctr");
    expect(ctr.available).toBe(true);
    expect(ctr.value).toBeCloseTo(40 / 1000, 6);
  });

  test("7. a partial day appears in the series and never in the totals", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();

    /* A window running up to today: the last few days are still being counted
       as spend reconciles and late conversions arrive. */
    const from = DAY(-9);
    const to = TODAY;
    const days = [...datesBetween(from, to)];

    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) }, { from, to });

    const out = await reportService.report({
      companyId: A, campaignDraftId: plan._id, draftRef: plan.draftRef, startDate: from, endDate: to,
    });
    const d = out.deployments[0];

    /* ── THE PARTIAL DAYS ARE SHOWN ──────────────────────────────────────
       Hiding them would be its own lie: a chart that stops three days ago
       looks like a campaign that stopped. */
    const partial = d.daily.filter((x) => x.completeness === "partial");
    expect(partial.length).toBeGreaterThan(0);
    for (const day of partial) {
      expect(day.impressions).toBe(1000);
      expect(day.countsTowardTotals).toBe(false);
    }

    /* ── AND THEY ARE NOT IN THE TOTAL ───────────────────────────────────
       A month with a half-counted day in it looks like a month that dropped. */
    const settled = d.daily.filter((x) => x.countsTowardTotals).length;
    expect(d.totals.impressions).toBe(1000 * settled);
    expect(settled).toBeLessThan(days.length);

    expect(d.coverage.daysCounted).toBe(settled);
    expect(d.coverage.daysPartial).toBe(partial.length);
    expect(d.coverage.means).toMatch(/still being counted/i);
    expect(d.gaps.some((g) => g.completeness === "partial")).toBe(true);
  });

  test("8. two currencies produce no combined money figure, and say why", async () => {
    const plan = await makePlan(["google_ads", "meta_ads"]);
    const gDep = await makeDeployment(plan, { channel: "google_ads" });
    const mDep = await makeDeployment(plan, { channel: "meta_ads", campaignId: "9001" });
    await bindAccount({ channel: "google_ads", currency: "INR" });
    await bindAccount({ channel: "meta_ads", currency: "USD" });

    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(gDep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });
    await syncWindow(mDep, {
      metaAds: { campaignDailyInsights: jest.fn(async () => ({ currency: "USD", days: days.map((d) => metaDay(d)), rowsRead: days.length })) },
    });

    const out = await reportFor(plan);
    expect(out.deployments).toHaveLength(2);

    /* ── COUNTS ADD. MONEY DOES NOT. ─────────────────────────────────────
       500 INR plus 20 USD is not 520 of anything, and no conversion rate is
       applied: GRAV has none, and a converted figure looks like money and is
       not. */
    expect(out.combined.applicable).toBe(true);
    expect(out.combined.currency).toBeNull();
    expect(out.combined.totals.impressions).toBe((1000 + 2000) * days.length);
    expect(out.combined.totals.clicks).toBe((40 + 60) * days.length);
    expect(out.combined.totals).not.toHaveProperty("spendMinorUnits");

    const spendWithheld = out.combined.withheld.find((w) => w.metric === "spend");
    expect(spendWithheld.why).toMatch(/different currencies/i);
    expect(spendWithheld.currencies.sort()).toEqual(["INR", "USD"]);

    /* ── AND TWO THINGS ARE WITHHELD WHATEVER THE CURRENCY ────────────────
       Reach counts people and the same person can be on both channels.
       Conversions mean different things in each. */
    expect(out.combined.withheld.find((w) => w.metric === "reach").why).toMatch(/invent an audience/i);
    expect(out.combined.withheld.find((w) => w.metric === "conversions").why).toMatch(/comparable to nothing/i);

    /* A money ratio cannot be derived from a withheld total. */
    expect(out.combined.derived.find((d) => d.code === "cpc").available).toBe(false);
    /* But a count ratio can. */
    expect(out.combined.derived.find((d) => d.code === "ctr").available).toBe(true);
  });

  test("9. one currency does combine money, and each deployment is still returned separately", async () => {
    const plan = await makePlan(["google_ads", "meta_ads"]);
    const gDep = await makeDeployment(plan, { channel: "google_ads" });
    const mDep = await makeDeployment(plan, { channel: "meta_ads", campaignId: "9001" });
    await bindAccount({ channel: "google_ads", currency: "INR" });
    await bindAccount({ channel: "meta_ads", currency: "INR" });

    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(gDep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });
    await syncWindow(mDep, { metaAds: fakeMeta(days.map((d) => metaDay(d))) });

    const out = await reportFor(plan);

    /* Each deployment on its own terms — a marketer comparing channels needs
       them apart, and the combined figure is an addition to that, not a
       replacement. */
    expect(out.deployments.map((d) => d.channel).sort()).toEqual(["google_ads", "meta_ads"]);
    expect(out.combined.currency).toBe("INR");

    const googleSpend = Math.round((1234567 * days.length) / 10000);
    const metaSpend = Math.round((Math.round(12.34 * 1000000) * days.length) / 10000);
    expect(out.combined.totals.spendMinorUnits).toBe(googleSpend + metaSpend);

    /* ── AND FOUR THINGS STAY WITHHELD, FOR TWO DIFFERENT REASONS ────────
       Reach and conversions were never about currency: the same person can be
       on both channels, and each channel decides for itself what a conversion
       is.

       Landing-page views and conversion value are withheld for the other
       reason — only one of the two channels reports them at all, and a sum of
       the channel GRAV could measure, presented as the plan's total,
       understates it by exactly the amount nobody can see. */
    const withheld = Object.fromEntries(out.combined.withheld.map((w) => [w.metric, w.why]));
    expect(Object.keys(withheld).sort())
      .toEqual(["conversionValue", "conversions", "landingPageViews", "reach"]);
    expect(withheld.reach).toMatch(/invent an audience/i);
    expect(withheld.conversions).toMatch(/comparable to nothing/i);
    expect(withheld.landingPageViews).toMatch(/would understate it/i);
    expect(withheld.conversionValue).toMatch(/would understate it/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10–14. THE SYNC
   ═══════════════════════════════════════════════════════════════════════════ */

describe("reading the channels", () => {
  test("10. syncing twice changes nothing the second time", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    const client = fakeGoogle(days.map((d) => googleDay(d)));

    const first = await syncWindow(dep, { googleAds: client });
    expect(first.daysChanged).toBe(days.length);

    const second = await syncWindow(dep, { googleAds: client });
    /* ── IDEMPOTENT BY FINGERPRINT, NOT BY LUCK ──────────────────────────
       The channel said the same thing, so nothing moved — no new row, no new
       revision, no new history entry. */
    expect(second.daysChanged).toBe(0);
    expect(second.daysUnchanged).toBe(days.length);

    expect(await MarketingCampaignObservation.countDocuments({ companyId: A })).toBe(days.length);
    expect(await MarketingCampaignObservationRevision.countDocuments({ companyId: A })).toBe(0);

    const rows = await MarketingCampaignObservation.find({ companyId: A }).lean();
    for (const r of rows) expect(r.metricRevision).toBe(1);
  });

  test("11. a channel correcting itself supersedes the earlier figure and keeps it", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d, { costMicros: 1000000 }))) });

    /* ── CHANNELS REVISE THEIR OWN NUMBERS ROUTINELY ──────────────────────
       Spend is reconciled and late conversions arrive. A figure that moved with
       no record of having moved costs somebody an afternoon. */
    const second = await syncWindow(dep, {
      googleAds: fakeGoogle(days.map((d) => googleDay(d, { costMicros: 1100000, conversions: 3 }))),
    });
    expect(second.daysChanged).toBe(days.length);

    const row = await MarketingCampaignObservation.findOne({ companyId: A }).sort({ reportingDate: 1 }).lean();
    expect(row.metricRevision).toBe(2);
    expect(row.spendMicros).toBe(1100000);

    const history = await MarketingCampaignObservationRevision
      .findOne({ companyId: A, observationId: row._id }).lean();
    expect(history.metricRevision).toBe(1);
    expect(history.spendMicros).toBe(1000000);
    expect(history.supersededAt).toBeTruthy();

    /* The history is append-only: a superseded figure cannot be quietly
       rewritten. */
    await expect(MarketingCampaignObservationRevision.updateOne(
      { _id: history._id }, { $set: { spendMicros: 1 } },
    )).rejects.toThrow(/append-only/i);

    /* And the report shows the corrected figure, with the revision visible so a
       reader can tell the channel moved it rather than GRAV. */
    const out = await reportFor(plan);
    expect(out.deployments[0].daily[0].metricRevision).toBe(2);
  });

  test("12. a provider outage preserves what was there and reports it honestly", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });
    const before = await reportFor(plan);
    expect(before.deployments[0].totals.impressions).toBe(1000 * days.length);

    /* ── A FAILED READ NEVER OVERWRITES A FIGURE THAT WAS TRUE ────────────
       Wiping yesterday's figures because today's request timed out would turn
       an outage into data loss. */
    const out = await syncWindow(dep, {
      googleAds: { campaignDailyReport: async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); } },
    });
    expect(out.read).toBe("channel_unavailable");

    const after = await reportFor(plan);
    /* The stored figures did not survive as figures — the day is now marked
       unavailable, which is the honest state — but nothing was invented and
       the previous values are kept in history. */
    expect(after.deployments[0].gaps.some((g) => g.code === "channel_unavailable")).toBe(true);
    expect(after.deployments[0].totals.impressions).toBeNull();
    expect(await MarketingCampaignObservationRevision.countDocuments({ companyId: A })).toBe(days.length);

    /* A refusal is a different fact from an outage. */
    const refused = await syncWindow(dep, {
      googleAds: { campaignDailyReport: async () => { throw fail("CHANNEL_ACCESS_REFUSED", "no"); } },
    });
    expect(refused.read).toBe("channel_refused");
  });

  test("13. a rebound account is refused before any figure is published", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });

    /* ── THE CAMPAIGN LIVES IN THE OLD ACCOUNT ───────────────────────────
       Reading the new one for a campaign id that means something else there
       would attach a stranger's spend to somebody's plan. */
    await Binding.updateOne(
      { companyId: A, channel: "google_ads" },
      { $set: { externalAccountId: "5555555555" } },
    );

    const client = fakeGoogle(days.map((d) => googleDay(d, { impressions: 99999 })));
    const err = await syncWindow(dep, { googleAds: client }).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED");
    expect(err.message).toMatch(/different advertising account/i);

    /* Not one request was made, and not one figure changed. */
    expect(client.campaignDailyReport).not.toHaveBeenCalled();
    const out = await reportFor(plan);
    expect(out.deployments[0].totals.impressions).toBe(1000 * days.length);
  });

  test("14. a day the channel simply did not return is a day of zeros, and a day never read is not", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];

    /* ── THE ONE PLACE A ZERO IS HONEST ──────────────────────────────────
       The read SUCCEEDED and the channel returned no row for that day. That is
       the channel saying the campaign did nothing — which is a fact, unlike a
       day GRAV could not ask about. */
    const [skipped, ...rest] = days;
    await syncWindow(dep, { googleAds: fakeGoogle(rest.map((d) => googleDay(d))) });

    const out = await reportFor(plan);
    const day = out.deployments[0].daily.find((d) => d.date === skipped);
    expect(day.completeness).toBe("complete");
    expect(day.impressions).toBe(0);
    expect(day.spendMinorUnits).toBe(0);
    /* Reach stays null even here: no row means no activity, not that reach was
       measured as zero — and Google never reports it at all. */
    expect(day.reach).toBeNull();

    /* A day outside the synced window has never been read, and looks different. */
    const wider = await reportService.report({
      companyId: A, campaignDraftId: plan._id, draftRef: plan.draftRef,
      startDate: DAY(-20), endDate: SETTLED_TO,
    });
    const neverRead = wider.deployments[0].daily.find((d) => d.date === DAY(-20));
    expect(neverRead.completeness).toBe("unavailable");
    expect(neverRead.reason).toBe("never_read");
    expect(neverRead.impressions).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   15–18. THE BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the boundary", () => {
  test("15. one company cannot read, write or refresh another's figures", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });

    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });

    /* ── READ ─────────────────────────────────────────────────────────────
       Every selector carries the company, so another tenant sees an empty
       report rather than somebody else's spend. */
    const theirs = await reportService.report({
      companyId: other._id, campaignDraftId: plan._id, draftRef: plan.draftRef,
      startDate: SETTLED_FROM, endDate: SETTLED_TO,
    });
    expect(theirs.deployments).toEqual([]);

    /* ── WRITE ────────────────────────────────────────────────────────────
       The deployment is resolved company-scoped, so a leaked deployment id
       reaches nothing. */
    await expect(sync.sync({
      companyId: other._id, deploymentId: dep._id,
      startDate: SETTLED_FROM, endDate: SETTLED_TO,
    }, { googleAds: fakeGoogle([]) })).rejects.toMatchObject({ code: "NOT_FOUND" });

    /* And this company's observations are untouched by any of it. */
    expect(await MarketingCampaignObservation.countDocuments({ companyId: A })).toBe(days.length);
    expect(await MarketingCampaignObservation.countDocuments({ companyId: other._id })).toBe(0);
  });

  test("16. nothing external can be changed from this slice", async () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "../..");

    const files = [
      "services/marketing/performance/observationSync.service.js",
      "services/marketing/performance/campaignReport.service.js",
      "routes/CMS_Routes/Marketing/campaignPerformance.js",
    ];

    for (const file of files) {
      const src = fs.readFileSync(path.join(root, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      /* ── NO WRITE CLIENT IS REACHABLE ─────────────────────────────────── */
      expect(src).not.toMatch(/googleSearchBundle|metaAdsWriteClient/);
      /* ── AND NOTHING ASKS THE HTTP LAYER FOR PERMISSION TO WRITE ──────── */
      expect(src).not.toMatch(/mutationIntent/);
      expect(src).not.toMatch(/:mutate|mutateOperations/);
    }

    /* The sync service's exports carry nothing that could create or change. */
    for (const name of Object.keys(sync)) {
      expect(name).not.toMatch(/create|update|delete|activate|pause|mutate/i);
    }
  });

  test("17. no Sales record is created or changed", async () => {
    const Lead = require("../../models/CMS_Models/Sales/Lead");
    const Account = require("../../models/CMS_Models/Sales/Account");
    const Activity = require("../../models/CMS_Models/Sales/Activity");

    const before = await Promise.all([
      Lead.countDocuments({}), Account.countDocuments({}), Activity.countDocuments({}),
    ]);

    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });
    await reportFor(plan);

    const after = await Promise.all([
      Lead.countDocuments({}), Account.countDocuments({}), Activity.countDocuments({}),
    ]);
    /* ── REPORTING IS NOT ATTRIBUTION ────────────────────────────────────
       A conversion figure from an advertising channel is not a lead in GRAV,
       and inventing one would put fictional people in somebody's pipeline. */
    expect(after).toEqual(before);

    /* And no marketing source is written anywhere either. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/marketing/performance/observationSync.service.js"), "utf8",
    );
    expect(src).not.toMatch(/Sales\/|Lead|Enquiry|Account\b/);
  });

  test("18. no credential, provider error or database identifier reaches the API", async () => {
    const plan = await makePlan();
    const dep = await makeDeployment(plan);
    await bindAccount();
    const days = [...datesBetween(SETTLED_FROM, SETTLED_TO)];
    await syncWindow(dep, { googleAds: fakeGoogle(days.map((d) => googleDay(d))) });

    const id = require("../../services/marketing/campaignDrafts/draftIdentity")
      .encodeDraftId({ companyId: String(A), draftId: String(plan._id) });

    const res = await call(`/campaign-drafts/${id}/performance`);
    expect(res.status).toBe(200);
    const flat = JSON.stringify(res.body);

    /* No credential, no provider host, no raw error. */
    expect(flat).not.toMatch(/googleads\.googleapis|graph\.facebook|Bearer|access_token/i);
    expect(flat).not.toMatch(/GOOGLE_ADS_[A-Z_]+|META_ADS_[A-Z_]+|MARKETING_CHANNEL_ID_SECRET/);
    /* ── NO ACCOUNT, NO EXTERNAL CAMPAIGN, NO DATABASE ID ────────────────
       A reader is told which CHANNEL. That is enough to render and it names
       nobody's advertising account. */
    expect(flat).not.toContain(GOOGLE_ACCOUNT);
    expect(flat).not.toContain("3001");
    expect(flat).not.toContain(String(A));
    expect(flat).not.toContain(String(dep._id));
    expect(flat).not.toMatch(/"_id"|externalAccountId|externalCampaignId|deploymentId/);
    /* ── AND NO INTERNAL STAGE ──────────────────────────────────────────
       `metricRevision` IS published and is meant to be: a reader seeing a
       figure move can tell the channel revised it rather than GRAV. What must
       not travel is GRAV's own bookkeeping. */
    expect(flat).not.toMatch(/factsFingerprint|__totals|__resolution|observationId/);

    expect(res.body.canChangeCampaign).toBe(false);
    expect(res.body.canActivateCampaign).toBe(false);
    expect(res.body.rawResponsesStored).toBe(false);
  });

  test("19. refreshing is an administrator's action and changes nothing externally", async () => {
    const plan = await makePlan();
    await makeDeployment(plan);
    await bindAccount();

    const id = require("../../services/marketing/campaignDrafts/draftIdentity")
      .encodeDraftId({ companyId: String(A), draftId: String(plan._id) });

    const asMarketer = await call(`/campaign-drafts/${id}/performance/refresh`, {
      user: MARKETER, method: "POST", body: {},
    });
    expect(asMarketer.status).toBe(403);
    expect(asMarketer.body.message).toMatch(/administrator/i);

    /* A marketer may still READ — the restriction is about the cost of the
       action, not the sensitivity of the data. */
    const read = await call(`/campaign-drafts/${id}/performance`, { user: MARKETER });
    expect(read.status).toBe(200);

    /* And an unknown body field is refused by name rather than ignored. */
    const bad = await call(`/campaign-drafts/${id}/performance/refresh`, {
      user: ADMIN, method: "POST", body: { startDate: SETTLED_FROM, campaignId: "3001" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/campaignId/);
  });

  test("20. an impossible range is refused rather than truncated", async () => {
    const plan = await makePlan();
    await makeDeployment(plan);
    await bindAccount();

    await expect(reportService.report({
      companyId: A, campaignDraftId: plan._id, startDate: SETTLED_TO, endDate: SETTLED_FROM,
    })).rejects.toMatchObject({ details: { code: "RANGE_INVALID" } });

    await expect(reportService.report({
      companyId: A, campaignDraftId: plan._id, startDate: "2020-01-01", endDate: "2026-09-20",
    })).rejects.toMatchObject({ details: { code: "RANGE_TOO_LONG" } });

    /* A date that is not a date, and one that does not exist. */
    await expect(reportService.report({
      companyId: A, campaignDraftId: plan._id, startDate: "20th Sept", endDate: SETTLED_TO,
    })).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(sync.sync({
      companyId: A, deploymentId: new mongoose.Types.ObjectId(),
      startDate: "2026-02-31", endDate: "2026-03-01",
    }, {})).rejects.toThrow(/not a real date/i);
  });
});

/* Every date in a window, inclusive. */
function* datesBetween(from, to) {
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86400000;
  }
}
