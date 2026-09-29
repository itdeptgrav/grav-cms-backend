// test/marketing/budget-pacing.route.test.js
//
// BUDGET PACING: A VERDICT ONLY WHEN THE FIGURES SUPPORT ONE.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Daily and total budgets are paced by the stated calculation, from settled
//   days only, and a genuine zero spend stays zero.
//   A schedule not started, a first day not yet settled, an unread day, a day
//   without a spend figure, settled data too far behind, a different
//   currency, an earlier revision's campaign or a plan in several channels
//   each withholds the verdict with its own reason — an unread day is never a
//   day of zero spend, and two channels are never added.
//   Another company's plan and figures are invisible, reading writes nothing,
//   and no advertising channel is contacted.
"use strict";

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "marketing_viewer", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const { MarketingCampaignObservation } = require("../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const { MarketingCampaignDraft, MarketingCampaignDraftHistory } = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const pacingService = require("../../services/marketing/performance/budgetPacing.service");
const zoned = require("../../services/marketing/contentPlan/zonedTime");
const googleAds = require("../../services/marketing/channels/googleAdsClient");
const metaAds = require("../../services/marketing/channels/metaAdsClient");
const observationSync = require("../../services/marketing/performance/observationSync.service");

const oid = () => new mongoose.Types.ObjectId();
const MARKETER = { id: String(oid()), name: "Mo", role: "marketing", email: "mo@grav.in" };
const VIEWER = { id: String(oid()), name: "Vee", role: "marketing_viewer", email: "vee@grav.in" };
const ADMIN = { id: String(oid()), name: "Ada", role: "admin", email: "ada@grav.in" };

const ZONE = "Asia/Kolkata";
/* "Today" as the advertising account counts it — never the server's day. */
const TODAY = zoned.localOf(Date.now(), ZONE).date;
const DAY = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

let A; let B; let server; let base;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const savedSecret = process.env.MARKETING_CHANNEL_ID_SECRET;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignPerformance"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.MARKETING_CHANNEL_ID_SECRET;
  else process.env.MARKETING_CHANNEL_ID_SECRET = savedSecret;
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
});
afterEach(() => jest.restoreAllMocks());

/* ═══ FIXTURES ════════════════════════════════════════════════════════════ */

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
  euPoliticalAdvertising: "does_not_contain",
  budgetRelationship: "campaign_daily",
  googleSearch: {
    headlines: ["Winter uniforms", "Hotel uniforms", "Bulk orders"],
    descriptions: ["Made to measure for hospitality.", "Delivered across India."],
    keywordThemes: ["hotel uniforms", "hospital uniforms"],
  },
  timezone: ZONE,
});

/** An approved plan, through the real submit and approval path. */
async function approvedPlan({ start, end, amount = 1000, basis = "daily", company = A, approve = true, currency = "INR" } = {}) {
  const created = await drafts.create({
    companyId: company, user: MARKETER,
    payload: {
      name: "Winter uniforms", objective: "lead_generation", channels: ["google_ads"],
      startDate: start, endDate: end, budgetAmount: amount, budgetCurrency: currency, budgetBasis: basis,
      conversionGoal: "form_submission", utmCampaign: fresh("winter"), idempotencyKey: fresh("k-plan"),
      deploymentBriefs: [{ ...GOOGLE_BRIEF, budgetRelationship: basis === "daily" ? "campaign_daily" : "campaign_total" }],
    },
  });
  if (approve) {
    await drafts.submit({ companyId: company, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision });
    await drafts.decide({ companyId: company, user: ADMIN, campaignDraftId: created.campaignDraftId, decision: "approve", reason: "Go." });
  }
  const plan = await drafts.loadForDeployment({ companyId: company, campaignDraftId: created.campaignDraftId });
  return { plan, publicId: created.campaignDraftId };
}

/* ── RUNNING, AS GRAV WOULD KNOW IT ─────────────────────────────────────────
   By default a deployment here is a campaign GRAV has CONFIRMED running:
   recorded `activated` and its campaign object read back from the channel as
   delivering. `stopped: true` is one created stopped and read back stopped. */
const RUNNING_WORD = { google_ads: "ENABLED", meta_ads: "ACTIVE" };
function campaignObject(channel, { delivering = true, readBack = true, observedState } = {}) {
  return {
    role: "campaign",
    providerObjectId: "3001",
    deliveryStateApplies: true,
    nonDeliveringConfirmed: readBack ? !delivering : null,
    stateReadAt: readBack ? new Date() : null,
    observedState: observedState ?? (readBack ? (delivering ? RUNNING_WORD[channel] : "PAUSED") : ""),
    createdAt: new Date(),
  };
}

async function deploy(plan, {
  channel = "google_ads", stopped = false, state = stopped ? "paused_confirmed" : "activated",
  revision = plan.revision, company = plan.companyId, readBack = {},
} = {}) {
  return MarketingCampaignDeployment.create({
    companyId: company,
    campaignDraftId: plan._id,
    draftRef: plan.draftRef,
    approvedRevision: revision,
    channel,
    campaignType: channel === "google_ads" ? "google_search" : "meta_traffic_single_image",
    idempotencyKey: fresh("dep"),
    state,
    deploymentApprovedBy: { id: oid(), name: "Ada", at: new Date() },
    externalObjects: state === "failed" ? [] : [campaignObject(channel, { delivering: !stopped, ...readBack })],
  });
}

/** One stored day. `spend` is in major units; `null` means the channel reported none. */
async function observe(plan, dep, date, { spend = 1000, completeness = "complete", currency = "INR", revision = plan.revision, company = plan.companyId } = {}) {
  const spendMicros = spend === null ? null : Math.round(spend * 1e6);
  return MarketingCampaignObservation.create({
    companyId: company,
    campaignDraftId: plan._id,
    draftRef: plan.draftRef,
    approvedRevision: revision,
    deploymentId: dep._id,
    channel: dep.channel,
    externalAccountId: "1234567890",
    externalCampaignId: "3001",
    reportingDate: date,
    reportingTimeZone: ZONE,
    currency,
    impressions: 1000,
    clicks: 40,
    spendMicros,
    spendMinorUnits: null,
    completeness,
    incompleteReason: completeness === "partial" ? "attribution_window_open" : completeness === "unavailable" ? "channel_unavailable" : "",
    observedAt: new Date(),
    metricRevision: 1,
    factsFingerprint: fresh("fp").slice(0, 60),
  });
}

/* Settled days start..DAY(-4), the last three still settling — as the sync writes them. */
async function typicalDays(plan, dep, start, { spend = 1000, currency = "INR" } = {}) {
  for (let d = start; d <= DAY(-4); d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    await observe(plan, dep, d, { spend: typeof spend === "function" ? spend(d) : spend, currency });
  }
  for (const n of [-3, -2, -1]) await observe(plan, dep, DAY(n), { spend: 999, completeness: "partial", currency });
}

const get = async (publicId, { user = MARKETER, company = A, query = "" } = {}) => {
  const res = await fetch(`${base}/campaign-drafts/${encodeURIComponent(publicId)}/pacing${query}`, {
    headers: { "x-test-user": JSON.stringify(user), "x-test-company": String(company) },
  });
  return { status: res.status, body: await res.json() };
};

/* ═══ 1. THE CALCULATION ══════════════════════════════════════════════════ */

describe("a verdict when the figures support one", () => {
  test("1. daily budget: settled days only, exact figures, the settling days left out", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10), amount: 1000, basis: "daily" });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20));

    const { status, body } = await get(publicId);
    expect(status).toBe(200);
    const p = body.pacing;
    expect(p).toEqual({
      available: true,
      verdict: expect.objectContaining({ code: "on_pace", label: "On pace" }),
      paceRatio: 1,
      basis: "daily",
      currency: "INR",
      timeZone: ZONE,
      scheduleState: "running",
      asOf: DAY(-4),
      elapsedDays: 17,
      scheduleDays: 31,
      stillSettlingDays: 3,
      minorUnitDigits: 2,
      spentToDateMinorUnits: 1700000,
      expectedToDateMinorUnits: 1700000,
      scheduleBudgetMinorUnits: 3100000,
      remainingBudgetMinorUnits: 1400000,
      overBudgetMinorUnits: 0,
    });
    /* The three unsettled days (999 each) are not in the spend. */
    expect(body.deployments).toHaveLength(1);
    expect(body.deployments[0]).toEqual(expect.objectContaining({ channel: "google_ads", approvedRevision: plan.revision, pacing: p }));
    expect(body.budget).toEqual({ amountMinorUnits: 100000, minorUnitDigits: 2, currency: "INR", basis: "daily" });
    expect(body.campaignPlan).toEqual({ draftRef: plan.draftRef, state: "approved", approvedRevision: plan.revision });
    expect([body.readsAdvertisingChannels, body.canChangeBudget, body.canChangeCampaign]).toEqual([false, false, false]);
    expect(body.calculation.daily).toMatch(/daily budget × the number of elapsed, settled days/);
  });

  test("2. total budget: an even spread over the schedule; under, on and over pace", async () => {
    /* 31-day schedule, 31,000 total: 1,000 a day is exactly on an even spread. */
    const cases = [[1000, "on_pace"], [500, "under_pace"], [1500, "over_pace"]];
    for (const [spend, verdict] of cases) {
      const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10), amount: 31000, basis: "total" });
      const dep = await deploy(plan);
      await typicalDays(plan, dep, DAY(-20), { spend });
      const p = (await get(publicId)).body.pacing;
      expect([spend, p.available, p.verdict.code, p.basis]).toEqual([spend, true, verdict, "total"]);
      expect(p.expectedToDateMinorUnits).toBe(1700000);
      expect(p.scheduleBudgetMinorUnits).toBe(3100000);
      expect(p.spentToDateMinorUnits).toBe(spend * 17 * 100);
    }
  });

  test("3. spend beyond the whole approved budget is over budget", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10), amount: 10000, basis: "total" });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20), { spend: 1000 });
    const p = (await get(publicId)).body.pacing;
    expect(p.verdict.code).toBe("over_budget");
    expect(p.overBudgetMinorUnits).toBe(700000);
    expect(p.remainingBudgetMinorUnits).toBe(0);
  });

  test("4. a genuine zero stays zero — reported, not assumed — for a campaign confirmed running", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    /* Confirmed running: GRAV started it and read it back delivering. */
    expect([dep.state, dep.externalObjects[0].observedState, dep.externalObjects[0].nonDeliveringConfirmed]).toEqual(["activated", "ENABLED", false]);
    await typicalDays(plan, dep, DAY(-20), { spend: 0 });
    const p = (await get(publicId)).body.pacing;
    expect([p.available, p.spentToDateMinorUnits, p.paceRatio, p.verdict.code]).toEqual([true, 0, 0, "under_pace"]);
  });

  test("5. an ended schedule is paced over the whole schedule", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-30), end: DAY(-10), amount: 1000 });
    const dep = await deploy(plan);
    for (let n = -30; n <= -10; n += 1) await observe(plan, dep, DAY(n), { spend: 900 });
    const p = (await get(publicId)).body.pacing;
    expect(p).toEqual(expect.objectContaining({
      available: true, scheduleState: "ended", asOf: DAY(-10), elapsedDays: 21, scheduleDays: 21, stillSettlingDays: 0,
    }));
    expect(p.verdict.code).toBe("on_pace");
    expect(p.paceRatio).toBe(0.9);
  });
});

/* ═══ 2. NO VERDICT, AND WHY ══════════════════════════════════════════════ */

describe("no verdict when the figures do not support one", () => {
  const reason = async (publicId) => (await get(publicId)).body.pacing.reason.code;

  test("6. not started, and started but nothing settled yet", async () => {
    let { plan, publicId } = await approvedPlan({ start: DAY(2), end: DAY(20) });
    await deploy(plan);
    expect(await reason(publicId)).toBe("not_started");
    const body = (await get(publicId)).body;
    expect(body.pacing.reason.means).toMatch(/No day of the approved schedule has finished yet/);

    ({ plan, publicId } = await approvedPlan({ start: DAY(-2), end: DAY(20) }));
    const dep = await deploy(plan);
    for (const n of [-2, -1]) await observe(plan, dep, DAY(n), { completeness: "partial" });
    expect(await reason(publicId)).toBe("no_settled_days");
  });

  test("7. an unread day is not zero: a gap stops the verdict, wherever it falls", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20));
    await MarketingCampaignObservation.collection.deleteOne({ deploymentId: dep._id, reportingDate: DAY(-12) });
    const res = (await get(publicId)).body.pacing;
    expect(res.available).toBe(false);
    expect(res.reason.code).toBe("missing_days");
    expect(res.detail).toEqual(expect.objectContaining({ firstMissingDate: DAY(-12) }));
    expect(res.reason.means).toMatch(/not a day of zero spend/);

    /* A day the channel failed to answer is the same. */
    const second = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep2 = await deploy(second.plan);
    await typicalDays(second.plan, dep2, DAY(-20));
    await MarketingCampaignObservation.collection.updateOne({ deploymentId: dep2._id, reportingDate: DAY(-15) }, { $set: { completeness: "unavailable", spendMicros: null } });
    expect(await reason(second.publicId)).toBe("missing_days");

    /* And days after the last read, not just between reads. */
    const third = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep3 = await deploy(third.plan);
    for (let n = -20; n <= -8; n += 1) await observe(third.plan, dep3, DAY(n));
    expect(await reason(third.publicId)).toBe("missing_days");
  });

  test("8. settled figures too far behind, and a settled day without a spend figure", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    for (let n = -20; n <= -10; n += 1) await observe(plan, dep, DAY(n));
    for (let n = -9; n <= -1; n += 1) await observe(plan, dep, DAY(n), { completeness: "partial" });
    const behind = (await get(publicId)).body.pacing;
    expect([behind.reason.code, behind.detail.lastSettledDate, behind.detail.unsettledDays]).toEqual(["settled_data_behind", DAY(-10), 9]);

    const second = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep2 = await deploy(second.plan);
    await typicalDays(second.plan, dep2, DAY(-20), { spend: (d) => (d === DAY(-6) ? null : 1000) });
    expect(await reason(second.publicId)).toBe("spend_not_reported");
  });

  test("9. a different currency is never compared or converted", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20));
    await MarketingCampaignObservation.collection.updateOne({ deploymentId: dep._id, reportingDate: DAY(-9) }, { $set: { currency: "USD" } });
    const res = (await get(publicId)).body.pacing;
    expect(res.reason.code).toBe("currency_mismatch");
    expect(res.detail).toEqual({ budgetCurrency: "INR", reportedCurrencies: ["INR", "USD"] });
  });

  test("10. a campaign from an earlier revision is not paced against the current budget", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const old = await deploy(plan, { revision: plan.revision - 1 });
    await typicalDays(plan, old, DAY(-20));
    const body = (await get(publicId)).body;
    expect(body.pacing.reason.code).toBe("revision_changed");
    expect(body.deployments[0].pacing.reason.code).toBe("revision_changed");
    expect(body.deployments[0].pacing.detail).toEqual({ campaignRevision: plan.revision - 1, approvedRevision: plan.revision });

    /* And the current campaign ignores figures stored under another revision. */
    const current = await deploy(plan);
    /* The settled days are stored under the earlier revision; only the three
       still-settling days are this revision's. Counting the earlier rows would
       produce a verdict; ignoring them leaves the settled days unread. */
    for (let n = -20; n <= -4; n += 1) await observe(plan, current, DAY(n), { revision: plan.revision - 1 });
    for (const n of [-3, -2, -1]) await observe(plan, current, DAY(n), { completeness: "partial" });
    const again = (await get(publicId)).body;
    const cur = again.deployments.find((d) => d.approvedRevision === plan.revision);
    expect(cur.pacing.reason.code).toBe("missing_days");
  });

  test("11. several channels: each paced alone, never added, and no plan-level verdict", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const google = await deploy(plan);
    const meta = await deploy(plan, { channel: "meta_ads" });
    await typicalDays(plan, google, DAY(-20), { spend: 1000 });
    /* Meta bills in another currency. */
    for (let n = -20; n <= -4; n += 1) await observe(plan, meta, DAY(n), { spend: 12, currency: "USD" });
    const body = (await get(publicId)).body;
    expect(body.pacing.reason.code).toBe("several_campaigns");
    expect(body.pacing.detail).toEqual({ channels: ["google_ads", "meta_ads"] });
    const byChannel = Object.fromEntries(body.deployments.map((d) => [d.channel, d.pacing]));
    expect(byChannel.google_ads.verdict.code).toBe("on_pace");
    /* Google's own spend only — Meta's figures are not in it. */
    expect(byChannel.google_ads.spentToDateMinorUnits).toBe(1700000);
    expect(byChannel.meta_ads.reason.code).toBe("currency_mismatch");
  });

  test("12. not approved, no campaign, campaign not created, basis conflicts", async () => {
    const draft = await approvedPlan({ start: DAY(-20), end: DAY(10), approve: false });
    const d = (await get(draft.publicId)).body;
    expect([d.pacing.reason.code, d.campaignPlan.approvedRevision, d.deployments]).toEqual(["plan_not_approved", null, []]);

    const bare = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    expect((await get(bare.publicId)).body.pacing.reason.code).toBe("not_deployed");

    const failed = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    await deploy(failed.plan, { state: "failed" });
    expect((await get(failed.publicId)).body.pacing.reason.code).toBe("campaign_not_created");

    /* The channel arrangement and the plan's basis must agree. */
    const { basisFor } = pacingService.__internals;
    expect(basisFor({ budget: { basis: "daily" } }, { budgetRelationship: "campaign_total" })).toEqual({ problem: "budget_basis_conflict" });
    expect(basisFor({ budget: { basis: "total" } }, { budgetRelationship: "campaign_daily" })).toEqual({ problem: "budget_basis_conflict" });
    expect(basisFor({ budget: { basis: "daily" } }, { budgetRelationship: "ad_set_daily" })).toEqual({ problem: "budget_per_audience" });
    expect(basisFor({ budget: { basis: "daily" } }, { budgetRelationship: "campaign_daily" })).toEqual({ basis: "daily" });

    const { planProblem } = pacingService.__internals;
    const approved = { state: "approved", schedule: { startDate: DAY(-2), endDate: DAY(2) } };
    expect(planProblem({ ...approved, budget: null }).reason.code).toBe("budget_missing");
    expect(planProblem({ ...approved, budget: { amount: 0, currency: "INR", basis: "daily" } }).reason.code).toBe("budget_zero");
    expect(planProblem({ ...approved, budget: { amount: 5, currency: "INR", basis: "daily" }, schedule: { startDate: DAY(2), endDate: DAY(-2) } }).reason.code).toBe("schedule_missing");
  });
});

/* ═══ 3. TENANCY, READS AND NOTHING ELSE ══════════════════════════════════ */

describe("company isolation, no writes, no provider", () => {
  test("13. another company cannot read the plan, and its rows never enter the figures", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20));
    expect((await get(publicId, { company: B })).status).toBe(404);

    /* Rows stamped with another company, even carrying this plan's own ids,
       are not read — here they would have made spend double. */
    for (let n = -20; n <= -4; n += 1) {
      await MarketingCampaignObservation.collection.insertOne({
        companyId: B, campaignDraftId: plan._id, draftRef: plan.draftRef, approvedRevision: plan.revision,
        /* This plan's REAL deployment id, so only the company keeps them out. */
        deploymentId: dep._id, channel: "google_ads", externalAccountId: "9", externalCampaignId: "9",
        reportingDate: DAY(n), reportingTimeZone: ZONE, currency: "INR", spendMicros: 5e9, completeness: "complete",
        observedAt: new Date(), metricRevision: 1, factsFingerprint: fresh("fpB"),
      });
    }
    await MarketingCampaignDeployment.collection.insertOne({
      companyId: B, campaignDraftId: plan._id, draftRef: plan.draftRef, approvedRevision: plan.revision,
      channel: "meta_ads", campaignType: "meta_traffic_single_image", idempotencyKey: fresh("depB"), state: "activated",
    });
    const body = (await get(publicId)).body;
    expect(body.deployments).toHaveLength(1);
    expect(body.pacing.spentToDateMinorUnits).toBe(1700000);
    expect(JSON.stringify(body)).not.toMatch(/1234567890|3001|"_id"|companyId|deploymentId|externalAccountId/);
  });

  test("14. reading writes nothing and contacts no advertising channel", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan);
    await typicalDays(plan, dep, DAY(-20));

    const spies = [
      ...Object.keys(googleAds).filter((k) => typeof googleAds[k] === "function").map((k) => jest.spyOn(googleAds, k)),
      ...Object.keys(metaAds).filter((k) => typeof metaAds[k] === "function").map((k) => jest.spyOn(metaAds, k)),
      jest.spyOn(observationSync, "sync"),
      jest.spyOn(observationSync, "syncPlan"),
    ];
    const snapshot = async () => ({
      plan: await MarketingCampaignDraft.findById(plan._id).lean(),
      history: await MarketingCampaignDraftHistory.countDocuments({}),
      deployments: await MarketingCampaignDeployment.find({}).lean(),
      observations: await MarketingCampaignObservation.find({}).lean(),
    });
    const before = await snapshot();
    for (const user of [MARKETER, VIEWER, ADMIN]) expect((await get(publicId, { user })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    for (const s of spies) expect(s).not.toHaveBeenCalled();

    /* Nothing in the service or route can reach a channel or a write path. */
    const src = [
      fs.readFileSync(path.join(__dirname, "../../services/marketing/performance/budgetPacing.service.js"), "utf8"),
    ].join("\n");
    for (const forbidden of ["googleAdsClient", "metaAdsClient", "metaAdsWriteClient", "googleSearchBundle", "observationSync", ".save(", "updateOne", "findOneAndUpdate", "insertMany", ".create("]) {
      expect([forbidden, src.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("15. the route takes no parameters and refuses a forged plan", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    await deploy(plan);
    expect((await get(publicId, { query: "?startDate=2026-01-01" })).status).toBe(400);
    expect((await get("not-a-plan")).status).toBe(404);
  });
});

/* ═══ 4. ONLY A CAMPAIGN CONFIRMED RUNNING HAS A PACE ═════════════════════ */

describe("stopped campaigns have no spending pace", () => {
  test("16. stopped with a genuine zero: no verdict of any kind, and the right reason", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan, { stopped: true });
    await typicalDays(plan, dep, DAY(-20), { spend: 0 });
    const p = (await get(publicId)).body.pacing;
    expect(p).toEqual({
      available: false,
      reason: expect.objectContaining({ code: "campaign_stopped", label: "Campaign is stopped; spending pace does not apply" }),
      detail: { campaignState: "paused_confirmed", measuredSpendIn: "performance_report" },
    });
    expect(p.verdict).toBeUndefined();
    expect(p.spentToDateMinorUnits).toBeUndefined();
  });

  test("17. stopped with historical spend: still no pace, and the spend stays in the performance report", async () => {
    const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
    const dep = await deploy(plan, { stopped: true });
    await typicalDays(plan, dep, DAY(-20), { spend: 1000 });
    expect((await get(publicId)).body.pacing.reason.code).toBe("campaign_stopped");

    const res = await fetch(`${base}/campaign-drafts/${encodeURIComponent(publicId)}/performance?startDate=${DAY(-20)}&endDate=${DAY(-1)}`, {
      headers: { "x-test-user": JSON.stringify(MARKETER), "x-test-company": String(A) },
    });
    const report = await res.json();
    expect(res.status).toBe(200);
    /* 17 settled days of 1,000 INR, in paise. */
    expect(report.deployments[0].totals.spendMinorUnits).toBe(1700000);
  });

  test("18. running is never inferred: activated without a delivering read-back is not paced", async () => {
    const cases = [
      ["no read-back", { readBack: false }],
      ["read back paused", { delivering: false }],
      ["read back delivering but in an unknown word", { observedState: "SOMETHING" }],
    ];
    for (const [why, readBack] of cases) {
      const { plan, publicId } = await approvedPlan({ start: DAY(-20), end: DAY(10) });
      const dep = await deploy(plan, { state: "activated", readBack });
      await typicalDays(plan, dep, DAY(-20));
      expect([why, (await get(publicId)).body.pacing.reason.code]).toEqual([why, "running_state_unconfirmed"]);
    }
    const { runningEvidence } = pacingService.__internals;
    /* A started schedule and real spend do not make a stopped campaign running. */
    expect(runningEvidence({ state: "paused_confirmed", channel: "google_ads", externalObjects: [campaignObject("google_ads")] })).toBe(false);
    expect(runningEvidence({ state: "activated", channel: "meta_ads", externalObjects: [campaignObject("meta_ads")] })).toBe(true);
    expect(runningEvidence({ state: "activated", channel: "google_ads", externalObjects: [] })).toBe(false);
  });
});

/* ═══ 5. MONEY IN THE CURRENCY'S OWN MINOR UNIT ═══════════════════════════ */

describe("minor units follow ISO 4217", () => {
  test("19. yen has no minor unit, dinar has three places — both exact", async () => {
    const jpy = await approvedPlan({ start: DAY(-20), end: DAY(10), amount: 1000, currency: "JPY" });
    const jDep = await deploy(jpy.plan);
    await typicalDays(jpy.plan, jDep, DAY(-20), { spend: 1000, currency: "JPY" });
    const j = (await get(jpy.publicId)).body;
    expect(j.budget).toEqual({ amountMinorUnits: 1000, minorUnitDigits: 0, currency: "JPY", basis: "daily" });
    expect([j.pacing.minorUnitDigits, j.pacing.spentToDateMinorUnits, j.pacing.scheduleBudgetMinorUnits]).toEqual([0, 17000, 31000]);

    const kwd = await approvedPlan({ start: DAY(-20), end: DAY(10), amount: 10, currency: "KWD" });
    const kDep = await deploy(kwd.plan);
    await typicalDays(kwd.plan, kDep, DAY(-20), { spend: 10, currency: "KWD" });
    const k = (await get(kwd.publicId)).body;
    expect(k.budget).toEqual({ amountMinorUnits: 10000, minorUnitDigits: 3, currency: "KWD", basis: "daily" });
    expect([k.pacing.minorUnitDigits, k.pacing.spentToDateMinorUnits, k.pacing.verdict.code]).toEqual([3, 170000, "on_pace"]);
  });

  test("20. a currency whose minor unit GRAV does not know gets no money figures at all", async () => {
    const { planProblem, toMinor } = pacingService.__internals;
    const p = planProblem({
      state: "approved", schedule: { startDate: DAY(-2), endDate: DAY(2) },
      budget: { amount: 100, currency: "XTS", basis: "daily" },
    });
    expect(p.reason.code).toBe("currency_precision_unsupported");
    expect(p.detail).toEqual({ currency: "XTS" });
    expect([toMinor(1234567, 2), toMinor(1234567, 0), toMinor(1234567, 3)]).toEqual([123, 1, 1235]);

    /* And the whole response publishes no amount in an assumed unit. */
    const plan = { draftRef: "MCP-x", state: "approved", revision: 1, _id: new mongoose.Types.ObjectId(),
      schedule: { startDate: DAY(-2), endDate: DAY(2) }, budget: { amount: 100, currency: "XTS", basis: "daily" }, deploymentBriefs: [] };
    const out = await pacingService.pacing({ companyId: A, plan });
    expect(out.budget).toEqual({ amountMinorUnits: null, minorUnitDigits: null, currency: "XTS", basis: "daily" });
    expect(out.pacing.reason.code).toBe("currency_precision_unsupported");
    expect(out.deployments).toEqual([]);
  });
});
