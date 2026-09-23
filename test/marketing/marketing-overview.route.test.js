// test/marketing/marketing-overview.route.test.js
//
// THE MARKETER'S LANDING PAGE.
//
// ── WHAT A SUMMARY GETS WRONG ──────────────────────────────────────────────
// Summaries fail in a particular way: they are the one screen where a wrong
// number looks most authoritative and is least checkable. Three failures are
// worth more than the rest, and most of this file is one of them.
//
//   A day GRAV never read, rendered as a day of zeroes. The chart looks like a
//   campaign that stopped working, and nobody can tell it from one that did.
//
//   Figures added together that do not mean the same thing — two currencies,
//   two channels' conversion definitions. The total is a number comparable to
//   nothing, and it is the number somebody will quote.
//
//   A word that promises more than the evidence. An approved plan called
//   "running". A synchronised contact called a lead. A possible email open
//   called engagement. Each is one noun away from a decision nobody should
//   make.
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
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const { MarketingCampaignObservation } = require("../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const { MarketingCampaignDraft } = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");

const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

let app; let server; let base; let A; let B;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingOverview"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const call = async (p = "/overview", { user = MARKETER, company = null } = {}) => {
  const res = await fetch(`${base}${p}`, {
    headers: { "x-test-user": JSON.stringify(user), "x-test-company": String(company || A) },
  });
  return { status: res.status, body: await res.json() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES
   ═══════════════════════════════════════════════════════════════════════════ */

const TODAY = new Date().toISOString().slice(0, 10);
const DAY = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/* Inside the default window (yesterday back 30 days), and far enough from
   today that every seeded day is settled. */
const IN_RANGE = (i) => DAY(-(i + 3));

async function makePlan(companyId, over = {}) {
  const created = await drafts.create({
    companyId, user: MARKETER,
    payload: {
      name: "Winter uniforms", objective: "lead_generation", channels: ["google_ads"],
      startDate: "2026-09-01", endDate: "2026-12-15", budgetAmount: 2500,
      budgetCurrency: "INR", budgetBasis: "daily", conversionGoal: "form_submission",
      utmCampaign: fresh("w"), idempotencyKey: fresh("k"), ...over,
    },
  });
  return drafts.loadForDeployment({ companyId, campaignDraftId: created.campaignDraftId });
}

async function makeDeployment(plan, { companyId, channel = "google_ads", state = "paused_confirmed" } = {}) {
  return MarketingCampaignDeployment.create({
    companyId, campaignDraftId: plan._id, draftRef: plan.draftRef,
    approvedRevision: plan.revision, channel,
    campaignType: channel === "google_ads" ? "google_search" : "meta_traffic_single_image",
    idempotencyKey: fresh("dep"), state,
    deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    externalObjects: [{
      role: "campaign", providerObjectId: "3001", deliveryStateApplies: true,
      nonDeliveringConfirmed: true, stateReadAt: new Date(), observedState: "PAUSED", createdAt: new Date(),
    }],
  });
}

async function seedDays(plan, deployment, { companyId, days = 10, over = {}, channel = "google_ads" } = {}) {
  const rows = [];
  for (let i = 1; i <= days; i += 1) {
    rows.push({
      companyId, campaignDraftId: plan._id, draftRef: plan.draftRef,
      approvedRevision: plan.revision, deploymentId: deployment._id, channel,
      externalAccountId: "1234567890", externalCampaignId: "3001",
      reportingDate: IN_RANGE(i), reportingTimeZone: "Asia/Kolkata", currency: "INR",
      impressions: 1000, reach: null, clicks: 40, landingPageViews: null,
      /* ₹50 a day, exactly, in micros. */
      spendMicros: 50000000, spendMinorUnits: 5000,
      conversions: 4, conversionValueMicros: null, conversionValueMinorUnits: null,
      conversionBasis: { countedTypes: ["form"], means: "Form submissions." },
      completeness: "complete", incompleteReason: "",
      observedAt: new Date(), metricRevision: 1, factsFingerprint: fresh("f"),
      ...over,
    });
  }
  await MarketingCampaignObservation.insertMany(rows);
}

/* A processed engagement event: the receipt is where a resolved person lives. */
async function engagement({ companyId, person, kind = "email_clicked", dayOffset = 5 }) {
  return MarketingEventReceipt.create({
    companyId, source: "mautic", sourceEventId: fresh("ev"),
    eventId: new mongoose.Types.ObjectId(), kind,
    occurredAt: new Date(`${IN_RANGE(dayOffset)}T10:00:00.000Z`),
    state: "RECORDED", gravPersonKey: person, resolvedBy: "canonical_identity", resolvedAt: new Date(),
  });
}

async function handover({ companyId, state = "AWAITING_REVIEW", dayOffset = 5 }) {
  const at = new Date(`${IN_RANGE(dayOffset)}T10:00:00.000Z`);
  return ProspectHandover.create({
    companyId,
    handoverRef: fresh("MPH"),
    correlationId: fresh("corr"),
    person: { gravPersonKey: fresh("person") },
    state,
    /* A blocked prospect was never submitted, so it has no submission time —
       which is exactly why the overview counts it by when the attempt was
       recorded instead. */
    submittedAt: state === "BLOCKED" ? null : at,
    createdAt: at,
    assessment: {
      intent: "moderate",
      handoverReason: "Clicked two campaign emails and asked for a quotation.",
      recommendedAction: "call_within_three_business_days",
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE FIGURES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("performance", () => {
  test("1. a fully populated company reports exact, checkable totals", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 10 });

    const { status, body } = await call();
    expect(status).toBe(200);

    /* 10 days × ₹50 = ₹500 = 50,000 paise. Summed in micros, rounded once. */
    expect(body.performance.spend).toMatchObject({ available: true, value: 50000, unit: "minor_units", currency: "INR" });
    expect(body.performance.impressions).toMatchObject({ available: true, value: 10000 });
    expect(body.performance.clicks).toMatchObject({ available: true, value: 400 });
    expect(body.performance.conversions).toMatchObject({ available: true, value: 40 });

    /* Derived, and reproducible from the figures beside them. */
    expect(body.performance.ctr.value).toBeCloseTo(400 / 10000, 6);
    expect(body.performance.cpc.value).toBeCloseTo(50000 / 400, 2);
    expect(body.performance.cpa.value).toBeCloseTo(50000 / 40, 2);

    expect(body.range.days).toBe(30);
    expect(body.range.defaulted).toBe(true);
    expect(body.range.timeZone).toBe("Asia/Kolkata");
    expect(body.readOnly).toBe(true);
  });

  test("2. the default range is the last 30 FINISHED days and excludes today", async () => {
    const { body } = await call();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    /* ── TODAY IS ALWAYS PARTIAL ─────────────────────────────────────────
       A default ending today would open every dashboard on a period whose
       last day is guaranteed to be excluded from its own totals. */
    expect(body.range.to).toBe(yesterday);
    expect(body.range.days).toBe(30);
    expect(body.dailyTrend).toHaveLength(30);
    expect(body.dailyTrend.map((d) => d.date)).not.toContain(TODAY);
  });

  test("3. a genuine measured zero stays zero and is not confused with unknown", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    /* The channel answered and reported nothing happened. Zeros are honest. */
    await seedDays(plan, dep, {
      companyId: A, days: 10,
      over: { impressions: 0, clicks: 0, spendMicros: 0, spendMinorUnits: 0, conversions: 0 },
    });

    const { body } = await call();

    expect(body.performance.spend).toMatchObject({ available: true, value: 0 });
    expect(body.performance.clicks).toMatchObject({ available: true, value: 0 });
    expect(body.performance.impressions).toMatchObject({ available: true, value: 0 });

    /* ── AND A RATIO OVER ZERO DOES NOT EXIST ────────────────────────────
       Not a rate of zero. A campaign that was never shown has no
       click-through rate, and the two lead to opposite conclusions about
       whether the creative is working. */
    expect(body.performance.ctr).toMatchObject({ available: false, value: null });
    expect(body.performance.ctr.why).toMatch(/not shown/i);
    expect(body.performance.cpa.why).toMatch(/nothing converted/i);
  });

  test("4. an unread day is never filled with zero", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    /* Five settled days inside a thirty-day window. The other twenty-five
       were never read. */
    await seedDays(plan, dep, { companyId: A, days: 5 });

    const { body } = await call();

    const read = body.dailyTrend.filter((d) => d.completeness === "complete");
    const unread = body.dailyTrend.filter((d) => d.completeness === "unavailable");
    expect(read).toHaveLength(5);
    expect(unread).toHaveLength(25);

    for (const day of unread) {
      /* ── THE SINGLE MOST DAMAGING THING A SUMMARY CAN DO ───────────────
         A gap in a chart and a run of zeroes look identical and mean
         opposite things. */
      expect(day.spend).toMatchObject({ available: false, value: null });
      expect(day.clicks).toMatchObject({ available: false, value: null });
      expect(day.conversions).toMatchObject({ available: false, value: null });
      expect(day.countsTowardTotals).toBe(false);
      expect(day.reason).toBe("never_read");
    }

    /* Totals cover the settled days only, and say so. */
    expect(body.performance.coverage).toMatchObject({ daysRequested: 30, daysCounted: 5, complete: false });
    expect(body.performance.clicks.value).toBe(200);
  });

  test("5. partial days are shown, labelled, and left out of totals", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });

    /* One day the channel reported but has not finished counting, carrying an
       enormous figure. If it leaked into a total it would dominate it. */
    await MarketingCampaignObservation.create({
      companyId: A, campaignDraftId: plan._id, draftRef: plan.draftRef,
      approvedRevision: plan.revision, deploymentId: dep._id, channel: "google_ads",
      externalAccountId: "1234567890", externalCampaignId: "3001",
      reportingDate: IN_RANGE(6), reportingTimeZone: "Asia/Kolkata", currency: "INR",
      impressions: 999999, clicks: 99999, spendMicros: 99999000000, spendMinorUnits: 9999900,
      conversions: 0, completeness: "partial", incompleteReason: "attribution_window_open",
      observedAt: new Date(), metricRevision: 1, factsFingerprint: fresh("p"),
    });

    const { body } = await call();

    const partial = body.dailyTrend.find((d) => d.completeness === "partial");
    expect(partial).toBeTruthy();
    expect(partial.countsTowardTotals).toBe(false);
    expect(partial.reason).toBe("attribution_window_open");
    /* Shown, not hidden — hiding it would be its own lie. */
    expect(partial.clicks).toMatchObject({ available: true, value: 99999 });

    expect(body.performance.clicks.value).toBe(200);
    expect(body.performance.coverage.daysPartial).toBe(1);
  });

  test("6. two currencies withhold the combined spend and explain it in business language", async () => {
    const inr = await makePlan(A);
    const inrDep = await makeDeployment(inr, { companyId: A });
    await seedDays(inr, inrDep, { companyId: A, days: 5 });

    const usd = await makePlan(A);
    const usdDep = await makeDeployment(usd, { companyId: A, channel: "meta_ads" });
    await seedDays(usd, usdDep, {
      companyId: A, days: 5, channel: "meta_ads", over: { currency: "USD", channel: "meta_ads" },
    });

    const { body } = await call();

    /* ── WITHHELD, NOT CONVERTED ─────────────────────────────────────────
       GRAV holds no exchange rate, a rate would be as of a moment nobody
       chose, and a converted total is a number that looks like money and is
       not. */
    expect(body.performance.spend).toMatchObject({ available: false, value: null });
    expect(body.performance.spend.why).toMatch(/different currencies/i);
    expect(body.performance.spend.currencies.sort()).toEqual(["INR", "USD"]);
    expect(body.performance.withheld.some((w) => w.metric === "spend")).toBe(true);

    /* Counts still add — they mean the same thing in both channels. */
    expect(body.performance.clicks).toMatchObject({ available: true, value: 400 });

    /* Conversions do NOT: each channel decides for itself what one is. */
    expect(body.performance.conversions).toMatchObject({ available: false, value: null });
    expect(body.performance.conversions.why).toMatch(/what counts as a conversion/i);

    /* And anything derived from a withheld figure is withheld too. */
    expect(body.performance.cpc.available).toBe(false);
    expect(body.performance.cpa.available).toBe(false);
    expect(body.performance.ctr.available).toBe(true);

    /* Said in plain language on the page, not only in a field. */
    expect(body.attention.some((a) => a.code === "spend_not_combinable")).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. CAMPAIGNS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("campaigns", () => {
  test("7. an approved plan is never called deployed, running or spending", async () => {
    const plan = await makePlan(A);
    await MarketingCampaignDraft.updateOne({ _id: plan._id }, { $set: { state: "approved" } });

    const { body } = await call();

    /* ── APPROVAL IS NOT DEPLOYMENT ──────────────────────────────────────
       An administrator agreeing to a plan creates nothing, commits no budget
       and spends no money. */
    expect(body.campaigns.rows).toHaveLength(0);
    expect(body.approvedNotDeployed.count).toBe(1);
    expect(body.approvedNotDeployed.means).toMatch(/Nothing has been created/i);

    const flat = JSON.stringify(body);
    expect(flat).not.toMatch(/\brunning\b/i);
    expect(flat).not.toMatch(/\bis active\b/i);

    expect(body.attention.some((a) => a.code === "approved_awaiting_creation")).toBe(true);
    expect(body.attention.some((a) => a.code === "no_campaigns_created")).toBe(true);
  });

  test("8. a confirmed but stopped campaign says exactly that", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A, state: "paused_confirmed" });
    await seedDays(plan, dep, { companyId: A, days: 10 });

    const { body } = await call();
    const row = body.campaigns.rows[0];

    expect(row.status).toBe("paused");
    expect(row.statusLabel).toBe("Created, not running");
    expect(row.delivering).toBe(false);
    expect(row.statusMeans).toMatch(/cannot deliver and cannot spend/i);
    expect(row.name).toBe("Winter uniforms");
    expect(row.draftRef).toBeTruthy();
  });

  test("9. a half-built deployment is not listed as a campaign", async () => {
    const plan = await makePlan(A);
    await MarketingCampaignDeployment.create({
      companyId: A, campaignDraftId: plan._id, draftRef: plan.draftRef,
      approvedRevision: plan.revision, channel: "google_ads", campaignType: "google_search",
      idempotencyKey: fresh("dep"), state: "partially_created",
      deploymentApprovedBy: { id: new mongoose.Types.ObjectId(), name: "Ada", at: new Date() },
    });

    const { body } = await call();

    /* ── A HALF-BUILT CAMPAIGN IS NOT A CAMPAIGN ─────────────────────────
       It cannot deliver, it has no figures, and a row on a dashboard looks
       like something that is working. */
    expect(body.campaigns.rows).toHaveLength(0);
    expect(body.availability.campaignPerformance).toBe(false);
  });

  test("10. several campaigns are ranked only where the ranking metric is comparable", async () => {
    const cheap = await makePlan(A, { name: "Cheap" });
    const cheapDep = await makeDeployment(cheap, { companyId: A });
    await seedDays(cheap, cheapDep, { companyId: A, days: 5, over: { conversions: 10 } });

    const dear = await makePlan(A, { name: "Dear" });
    const dearDep = await makeDeployment(dear, { companyId: A });
    await seedDays(dear, dearDep, { companyId: A, days: 5, over: { conversions: 2 } });

    const none = await makePlan(A, { name: "No conversions" });
    const noneDep = await makeDeployment(none, { companyId: A });
    await seedDays(none, noneDep, { companyId: A, days: 5, over: { conversions: 0 } });

    const { body } = await call();
    expect(body.campaigns.rows).toHaveLength(3);
    expect(body.campaigns.rankedBy).toBe("cpa");

    const ranked = body.campaigns.rows.filter((r) => r.ranked);
    expect(ranked.map((r) => r.name)).toEqual(["Cheap", "Dear"]);
    expect(ranked[0].rank).toBe(1);

    /* ── NOT RANKED IS NOT LAST ──────────────────────────────────────────
       A campaign with no conversions has no cost per conversion. Ranking it
       "worst" states a conclusion the absence of a ratio cannot support. */
    const unranked = body.campaigns.rows.find((r) => r.name === "No conversions");
    expect(unranked.ranked).toBe(false);
    expect(unranked.rank).toBeNull();
    expect(unranked.cpa).toMatchObject({ available: false, value: null });

    expect(body.attention.find((a) => a.code === "best_cost_per_conversion").detail).toMatch(/Cheap/);
  });

  test("11. campaigns in different currencies are not ranked against each other", async () => {
    const inr = await makePlan(A, { name: "Rupees" });
    const inrDep = await makeDeployment(inr, { companyId: A });
    await seedDays(inr, inrDep, { companyId: A, days: 5 });

    const usd = await makePlan(A, { name: "Dollars" });
    const usdDep = await makeDeployment(usd, { companyId: A, channel: "meta_ads" });
    await seedDays(usd, usdDep, { companyId: A, days: 5, channel: "meta_ads", over: { currency: "USD", channel: "meta_ads" } });

    const { body } = await call();

    /* Ordering two currencies by cost orders them by exchange rate. */
    expect(body.campaigns.rows.every((r) => r.ranked === false)).toBe(true);
    expect(body.campaigns.rankedBy).toBeNull();
    expect(body.campaigns.why).toMatch(/different currencies/i);

    /* Each campaign's own figures are still exact and carry their currency. */
    const rupees = body.campaigns.rows.find((r) => r.name === "Rupees");
    expect(rupees.spend).toMatchObject({ available: true, value: 25000, currency: "INR" });
  });

  test("12. no deployments at all is a calm, honest empty state", async () => {
    const { body } = await call();

    expect(body.campaigns.rows).toEqual([]);
    expect(body.performance.spend).toMatchObject({ available: false, value: null });
    expect(body.performance.spend.why).toMatch(/no settled advertising figures/i);
    expect(body.availability.campaignPerformance).toBe(false);
    expect(body.attention.some((a) => a.code === "no_campaigns_created")).toBe(true);
    /* Still 30 labelled days rather than an empty array. */
    expect(body.dailyTrend).toHaveLength(30);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. PROSPECT MOVEMENT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("prospect movement", () => {
  test("13. a possible email open is not engagement, and neither is a synchronised contact", async () => {
    /* One real click, and a pile of things that are not people doing things. */
    await engagement({ companyId: A, person: "p1", kind: "email_clicked" });
    await engagement({ companyId: A, person: "p2", kind: "email_opened" });
    await engagement({ companyId: A, person: "p3", kind: "email_delivered" });
    await engagement({ companyId: A, person: "p4", kind: "email_sent" });
    await engagement({ companyId: A, person: "p5", kind: "page_viewed" });

    const { body } = await call();
    const engaged = body.prospectMovement.stages.find((s) => s.code === "engaged_people");

    /* ── ONE ───────────────────────────────────────────────────────────── */
    expect(engaged.count).toBe(1);

    /* And the exclusions are published, so the figure can be reconciled
       against an email report that counts differently. */
    const excluded = body.prospectMovement.notCountedAsEngagement.map((n) => n.kind);
    expect(excluded).toEqual(expect.arrayContaining(["email_opened", "email_sent", "email_delivered", "page_viewed", "added_to_mailing"]));
    expect(body.prospectMovement.notCountedAsEngagement.find((n) => n.kind === "email_opened").why)
      .toMatch(/possible open/i);
    expect(body.prospectMovement.notCountedAsEngagement.find((n) => n.kind === "added_to_mailing").why)
      .toMatch(/something GRAV did/i);
  });

  test("14. one person who engages repeatedly is counted once", async () => {
    await engagement({ companyId: A, person: "same-person", dayOffset: 4 });
    await engagement({ companyId: A, person: "same-person", dayOffset: 5 });
    await engagement({ companyId: A, person: "same-person", dayOffset: 6 });
    await engagement({ companyId: A, person: "another", dayOffset: 5 });

    const { body } = await call();
    const engaged = body.prospectMovement.stages.find((s) => s.code === "engaged_people");

    /* Clicking four links is one interested person, not four. */
    expect(engaged.count).toBe(2);
    expect(engaged.means).toMatch(/counted once/i);
  });

  test("15. an unresolved person is not invented into a person", async () => {
    await engagement({ companyId: A, person: "known" });
    await MarketingEventReceipt.create({
      companyId: A, source: "mautic", sourceEventId: fresh("ev"),
      eventId: new mongoose.Types.ObjectId(), kind: "email_clicked",
      occurredAt: new Date(`${IN_RANGE(5)}T10:00:00.000Z`),
      state: "IDENTITY_UNRESOLVED", gravPersonKey: "",
    });

    const { body } = await call();
    /* GRAV does not know who that was, and one unresolved event is not
       evidence of one human being. */
    expect(body.prospectMovement.stages.find((s) => s.code === "engaged_people").count).toBe(1);
  });

  test("16. the stages are independently measured counts, never a funnel with rates", async () => {
    await engagement({ companyId: A, person: "p1" });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });
    await handover({ companyId: A, state: "ACCEPTED" });
    await handover({ companyId: A, state: "RETURNED" });
    await handover({ companyId: A, state: "REJECTED" });
    await handover({ companyId: A, state: "BLOCKED" });

    const { body } = await call();
    const m = body.prospectMovement;
    const count = (code) => m.stages.find((s) => s.code === code).count;

    expect(count("engaged_people")).toBe(1);
    expect(count("handovers_submitted")).toBe(4);
    expect(count("awaiting_review")).toBe(1);
    expect(count("accepted")).toBe(1);
    expect(count("returned")).toBe(1);
    expect(count("rejected")).toBe(1);
    expect(count("blocked")).toBe(1);

    /* ── SAID PLAINLY, NOT IMPLIED ───────────────────────────────────────
       Blocked prospects were never submitted, so they are not a residue of
       the submitted count; and a prospect's current state is a fact about
       today rather than about this period. There is no cohort a percentage
       would describe. */
    expect(m.coherentFunnel).toBe(false);
    expect(m.means).toMatch(/not stages of one funnel/i);

    /* ── NO RATE IS PUBLISHED ────────────────────────────────────────────
       Checked on the STRUCTURE rather than on the prose, because the prose
       contains the sentence "GRAV publishes no percentage between them" — a
       disclaimer, and the one mention of the word that should survive. A
       keyword sweep would delete the explanation along with the thing it
       explains. */
    for (const s of m.stages) {
      expect(Object.keys(s).sort()).toEqual(["code", "count", "label", "means"]);
      expect(typeof s.count).toBe("number");
    }
    expect(m).not.toHaveProperty("rates");
    expect(m).not.toHaveProperty("conversionRate");
    expect(JSON.stringify(m.stages)).not.toMatch(/percent|rate|%/i);

    /* Every stage carries its own definition. */
    for (const s of m.stages) expect(String(s.means).length).toBeGreaterThan(20);
  });

  test("17. a match to an existing Sales record is not reported as a rejection", async () => {
    await handover({ companyId: A, state: "DUPLICATE_LINKED" });
    await handover({ companyId: A, state: "REJECTED" });

    const { body } = await call();
    const count = (code) => body.prospectMovement.stages.find((s) => s.code === code).count;

    /* Folding it into "rejected" would report a successful match as a
       failure. */
    expect(count("linked_to_existing")).toBe(1);
    expect(count("rejected")).toBe(1);
    expect(body.handoverSummary.linkedToExisting).toBe(1);
  });

  test("18. no handovers is zero, calmly", async () => {
    const { body } = await call();

    expect(body.handoverSummary.total).toBe(0);
    expect(body.handoverSummary.awaitingReview).toBe(0);
    expect(body.availability.handovers).toBe(false);
    expect(body.attention.some((a) => a.code.startsWith("handovers_"))).toBe(false);
  });

  test("19. handover counts match the Handovers page exactly", async () => {
    await handover({ companyId: A, state: "AWAITING_REVIEW" });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });
    await handover({ companyId: A, state: "ACCEPTED" });

    const readModel = require("../../services/marketing/handoverReadModel.service");
    const theirs = await readModel.summaryFor({ companyId: A });
    const { body } = await call();

    /* The same function, so the two screens cannot disagree about how many
       people are waiting. */
    expect(body.handoverSummary.total).toBe(theirs.total);
    expect(body.handoverSummary.awaitingReview).toBe(theirs.byState.AWAITING_REVIEW);
    expect(body.handoverSummary.accepted).toBe(theirs.byState.ACCEPTED);
    expect(body.handoverSummary.destination.path).toBe("/marketing/handovers");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. ATTENTION, RANGE AND ISOLATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("attention, range and boundaries", () => {
  test("20. every attention item is reproducible from the response it came in", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });
    await handover({ companyId: A, state: "RETURNED" });

    const { body } = await call();
    expect(body.attention.length).toBeGreaterThan(0);

    for (const item of body.attention) {
      expect(item.code).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(String(item.detail).length).toBeGreaterThan(10);
      expect(["positive", "attention", "neutral"]).toContain(item.tone);
      expect(item.evidence).toBeTruthy();
      expect(item.destination.path).toMatch(/^\/marketing/);
    }

    /* ── EVIDENCE MEANS CHECKABLE ────────────────────────────────────────
       The awaiting-review item's number is the same number the movement
       section published. An item a reader cannot verify against the page it
       sits on is advice, not an observation. */
    const waiting = body.attention.find((a) => a.code === "handovers_awaiting_review");
    expect(waiting.evidence.count).toBe(
      body.prospectMovement.stages.find((s) => s.code === "awaiting_review").count,
    );

    const partial = body.attention.find((a) => a.code === "performance_partial");
    expect(partial.evidence.daysCounted).toBe(body.performance.coverage.daysCounted);

    /* No generic advice. */
    const flat = JSON.stringify(body.attention);
    expect(flat).not.toMatch(/you should|consider |try |we recommend|optimi[sz]e/i);
  });

  test("21. an explicit range is honoured and published; a bad one is refused", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });

    const from = IN_RANGE(5);
    const to = IN_RANGE(1);
    const ok = await call(`/overview?from=${from}&to=${to}`);
    expect(ok.status).toBe(200);
    expect(ok.body.range).toMatchObject({ from, to, days: 5, defaulted: false });
    expect(ok.body.dailyTrend).toHaveLength(5);

    /* Reversed. */
    const reversed = await call(`/overview?from=${to}&to=${from}`);
    expect(reversed.status).toBe(400);
    expect(reversed.body.message).toMatch(/start of that range is after its end/i);

    /* Malformed. */
    for (const bad of ["2026-13-01", "01-09-2026", "yesterday", "2026-09-1"]) {
      const res = await call(`/overview?from=${bad}&to=${to}`);
      expect(res.status).toBe(400);
    }

    /* An unknown parameter is refused by name rather than ignored. */
    const unknown = await call(`/overview?companyId=${B}`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/companyId/);
  });

  test("22. every section is scoped to the caller's company", async () => {
    /* Company A: a campaign, engagement and handovers. */
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });
    await engagement({ companyId: A, person: "a-person" });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });

    /* Company B: more of everything, so a leak would be obvious. */
    const theirPlan = await makePlan(B, { name: "Theirs" });
    const theirDep = await makeDeployment(theirPlan, { companyId: B });
    await seedDays(theirPlan, theirDep, { companyId: B, days: 20 });
    await engagement({ companyId: B, person: "b-person-1" });
    await engagement({ companyId: B, person: "b-person-2" });
    await handover({ companyId: B, state: "ACCEPTED" });
    await handover({ companyId: B, state: "ACCEPTED" });

    const mine = await call("/overview", { company: A });
    const theirs = await call("/overview", { company: B });

    expect(mine.body.campaigns.rows).toHaveLength(1);
    expect(mine.body.campaigns.rows[0].name).toBe("Winter uniforms");
    expect(mine.body.performance.clicks.value).toBe(200);
    expect(mine.body.prospectMovement.stages.find((s) => s.code === "engaged_people").count).toBe(1);
    expect(mine.body.handoverSummary.total).toBe(1);
    expect(JSON.stringify(mine.body)).not.toContain("Theirs");

    expect(theirs.body.campaigns.rows[0].name).toBe("Theirs");
    expect(theirs.body.performance.clicks.value).toBe(800);
    expect(theirs.body.prospectMovement.stages.find((s) => s.code === "engaged_people").count).toBe(2);
    expect(theirs.body.handoverSummary.total).toBe(2);
  });

  test("23. authorisation is Marketing membership", async () => {
    const anon = await fetch(`${base}/overview`, { headers: { "x-test-company": String(A) } });
    expect(anon.status).toBe(401);

    for (const role of ["store_manager", "quality_control", "accountant", ""]) {
      const res = await call("/overview", {
        user: { id: new mongoose.Types.ObjectId().toString(), name: "Outsider", role },
      });
      expect(res.status).toBe(403);
    }

    /* A marketer and an administrator both read it — this spends nothing and
       exposes nothing they cannot already see. */
    expect((await call("/overview", { user: MARKETER })).status).toBe(200);
    expect((await call("/overview", { user: ADMIN })).status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. WHAT MUST NOT BE IN THE RESPONSE, AND WHAT MUST NOT HAPPEN
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the boundary", () => {
  test("24. no identifier, address or technical vocabulary reaches the browser", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });
    await engagement({ companyId: A, person: "p1" });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });

    const { body } = await call();
    const flat = JSON.stringify(body);

    /* Identifiers. */
    expect(flat).not.toContain(String(A));
    expect(flat).not.toContain(String(plan._id));
    expect(flat).not.toContain(String(dep._id));
    expect(flat).not.toMatch(/\b[0-9a-f]{24}\b/i);
    expect(flat).not.toMatch(/"_id"/);
    expect(flat).not.toContain("1234567890");   // advertising account
    expect(flat).not.toContain("3001");          // external campaign

    /* People. */
    expect(flat).not.toMatch(/@/);
    expect(flat).not.toContain("p1");

    /* Provider names. */
    expect(flat).not.toMatch(/mautic|facebook|graph\.facebook|googleads\.googleapis|adwords/i);

    /* ── AND NONE OF THE WORDS A MARKETER CANNOT ACT ON ──────────────────
       Not because they are secret — because a summary that says
       "reconciliation pending" produces a support ticket about a system that
       is working correctly. */
    for (const word of [
      /\bsynchroni[sz]ation\b/i, /\bsynchroni[sz]ed\b/i, /\bretry\b/i, /\bretries\b/i,
      /\breconcil/i, /\bmapping\b/i, /\bengine\b/i, /\bcredential/i, /\bqueue\b/i,
      /\bwebhook\b/i, /\bdatabase\b/i, /\bprovider\b/i, /\bupstream\b/i, /\bAPI\b/,
      /\btoken\b/i, /\bbackoff\b/i, /\bfault\b/i,
    ]) {
      expect({ word: String(word), found: word.test(flat) }).toEqual({ word: String(word), found: false });
    }

    /* ── THE SIGNED PLAN IDENTIFIER IS PRESENT, AND THAT IS CORRECT ──────
       Navigation needs identity, and this is the established Marketing form —
       the same token the campaign, performance and health routes already use.

       Worth stating plainly rather than implying otherwise: it is SIGNED, not
       secret. The payload is base64, so the ids inside it can be read by
       anybody who decodes it; what the signature buys is that a token cannot
       be forged or pointed at another company, and `decodeDraftId` refuses one
       that was. The assertions above are about the response carrying no
       readable database id of its own, which is a different claim. */
    const draftIdentity = require("../../services/marketing/campaignDrafts/draftIdentity");
    const token = body.campaigns.rows[0].campaignPlanId;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(String(plan._id));

    const decoded = draftIdentity.decodeDraftId(token, { companyId: String(A) });
    expect(String(decoded.draftId ?? decoded)).toBe(String(plan._id));

    /* And it is scoped: another company's context cannot open it. */
    expect(() => draftIdentity.decodeDraftId(token, { companyId: String(B) }))
      .toThrow();
  });

  test("25. identities are never called leads", async () => {
    await engagement({ companyId: A, person: "p1" });
    const { body } = await call();

    /* ── A PERSON MARKETING KNOWS IS NOT A LEAD ──────────────────────────
       A Lead exists only once Sales accepts a prospect and creates one.
       Calling an engaged person a lead reports pipeline that does not exist.

       The single permitted mention is the field that denies it, so that is
       removed before the sweep rather than the sweep being softened — every
       other use of the word would be a real one. */
    const { peopleAreNotLeads, ...rest } = body.prospectMovement;
    const flat = JSON.stringify({ ...body, prospectMovement: rest });

    expect(flat).not.toMatch(/\blead\b/i);
    expect(flat).not.toMatch(/\bleads\b/i);
    expect(peopleAreNotLeads).toMatch(/not Leads/);

    /* And the label on the count is "people", not anything warmer. */
    expect(body.prospectMovement.stages.find((s) => s.code === "engaged_people").label)
      .toBe("People who engaged");
  });

  test("26. nothing is invented — no reach, revenue, ROAS or attribution", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });

    const { body } = await call();
    const flat = JSON.stringify(body);

    /* Reach cannot be added across days, channels or plans; a company-wide
       reach figure would be an invented audience. */
    expect(body.performance).not.toHaveProperty("reach");
    expect(flat).not.toMatch(/\broas\b/i);
    expect(flat).not.toMatch(/\brevenue\b/i);
    expect(flat).not.toMatch(/\battribut/i);
    expect(flat).not.toMatch(/\bforecast/i);
    expect(flat).not.toMatch(/\bpredict/i);
  });

  test("27. three identical GETs change nothing at all", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });
    await engagement({ companyId: A, person: "p1" });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });

    const countAll = async () => ({
      deployments: await MarketingCampaignDeployment.countDocuments({}),
      observations: await MarketingCampaignObservation.countDocuments({}),
      receipts: await MarketingEventReceipt.countDocuments({}),
      handovers: await ProspectHandover.countDocuments({}),
      drafts: await MarketingCampaignDraft.countDocuments({}),
    });

    const before = await countAll();
    const first = await call();
    const second = await call();
    const third = await call();
    const after = await countAll();

    /* ── A GET THAT IS ACTUALLY A GET ────────────────────────────────────── */
    expect(after).toEqual(before);

    /* And the answer is stable, not merely non-destructive. */
    expect(second.body.performance).toEqual(first.body.performance);
    expect(third.body.campaigns).toEqual(first.body.campaigns);
    expect(third.body.prospectMovement).toEqual(first.body.prospectMovement);
  });

  test("28. the route reaches no provider, no writer, no Sales model and no model", async () => {
    const root = path.join(__dirname, "../..");
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const files = [
      "routes/CMS_Routes/Marketing/marketingOverview.js",
      "services/marketing/overview/marketingOverview.service.js",
      "services/marketing/overview/overviewPerformance.js",
      "services/marketing/overview/overviewMovement.js",
    ];

    for (const rel of files) {
      const src = strip(fs.readFileSync(path.join(root, rel), "utf8"));

      /* No provider or HTTP client. */
      expect({ rel, m: /require\(["'].*(googleAdsClient|metaAdsClient|mauticClient|AdsWriteClient)/.test(src) })
        .toEqual({ rel, m: false });
      expect({ rel, m: /require\(["'](axios|node-fetch|got|https?)["']\)/.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /\bfetch\(|https?\.request\(/.test(src) }).toEqual({ rel, m: false });

      /* No deployment writer, no creation, no activation. */
      expect({ rel, m: /pausedCreation|metaPausedCreation|observationSync|deploymentAttempt/i.test(src) })
        .toEqual({ rel, m: false });

      /* ── NO SALES MODEL ──────────────────────────────────────────────────
         Marketing reads its own recorded outcomes. The tempting shortcut is
         one `Lead.findById` for a display name. */
      expect({ rel, m: /require\(["'].*(Sales\/|\/Lead|\/Account|\/Enquiry|\/Contact)/.test(src) })
        .toEqual({ rel, m: false });

      /* No model, no gateway. */
      expect({ rel, m: /gravAiGateway|@google\/genai|GoogleGenAI|ollamaClient|GEMINI/.test(src) })
        .toEqual({ rel, m: false });

      /* No write of any kind. */
      expect({ rel, m: /\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|save)\(/.test(src) })
        .toEqual({ rel, m: false });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. DESTINATIONS — ONE CANONICAL ROUTE PER SCREEN

   ── THE FAULT THESE EXIST TO END ─────────────────────────────────────────
   The campaign destination published `/marketing/campaigns/:campaignPlanId`.
   No such route is served. The frontend's per-campaign screen is the
   performance workspace, and the identifier this contract signs is the one it
   already takes — so every link built from the published path 404'd, and the
   client had begun keeping a table that mapped a destination CODE back onto a
   real address.

   That arrangement is worse than either half of it: the contract stays wrong,
   the client carries corrections, and they drift the moment one of them moves.
   So the rule is now that `path` is complete and correct as published, and
   these tests hold it against the routes the frontend actually serves.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("destinations are addresses, not templates", () => {
  const vocabulary = require("../../constants/marketingOverview");

  /* The sibling frontend checkout, when there is one. The route assertions
     below are the only ones that need it, and they say so rather than passing
     quietly where it is absent. */
  const FRONTEND = path.resolve(__dirname, "../../../grav-cms");
  const frontendPresent = fs.existsSync(path.join(FRONTEND, "app", "marketing"));

  /**
   * Whether the frontend serves a URL shape, resolved the way Next.js does.
   *
   * ── A TEMPLATE PARAMETER IS NOT A FOLDER NAME ────────────────────────────
   * The contract calls the parameter `:campaignPlanId`, because that is what
   * the response field is called and what a client substitutes. The route
   * folder is `[campaignDraftId]` — a name local to the frontend that never
   * appears in a URL. Requiring the two to match would be pinning somebody
   * else's variable name; what has to be true is that the ADDRESS resolves,
   * so a `:param` segment matches whichever single dynamic folder sits there.
   */
  function serves(urlPath) {
    let dir = path.join(FRONTEND, "app");
    for (const segment of urlPath.split("/").filter(Boolean)) {
      if (!fs.existsSync(dir)) return false;
      if (segment.startsWith(":")) {
        const dynamic = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^\[[^\]]+\]$/.test(e.name));
        /* Exactly one, or the address is ambiguous and this check means
           nothing. */
        if (dynamic.length !== 1) return false;
        dir = path.join(dir, dynamic[0].name);
      } else {
        dir = path.join(dir, segment);
      }
    }
    return fs.existsSync(path.join(dir, "page.js"));
  }

  test("30. every published path is usable as it stands", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });
    await handover({ companyId: A, state: "AWAITING_REVIEW" });

    const { body } = await call();

    const published = [
      ...body.campaigns.rows.map((r) => r.destination),
      ...body.attention.map((a) => a.destination),
      body.handoverSummary.destination,
    ];
    expect(published.length).toBeGreaterThan(2);

    for (const d of published) {
      expect(vocabulary.DESTINATION_CODES).toContain(d.code);
      expect(d.label).toBeTruthy();
      expect(d.path).toMatch(/^\/marketing\//);
      /* ── NO PARAMETER SURVIVES INTO A PATH ───────────────────────────
         A `path` still carrying `:campaignPlanId` is a link that 404s, and
         publishing one is the whole fault this section was written for. */
      expect({ path: d.path, unresolved: d.path.includes(":") }).toEqual({ path: d.path, unresolved: false });
      /* The shape travels beside it, for anybody who wants to see it. */
      expect(d.template).toBeTruthy();
    }
  });

  test("31. a campaign points at the performance workspace, with its own identifier", async () => {
    const plan = await makePlan(A);
    const dep = await makeDeployment(plan, { companyId: A });
    await seedDays(plan, dep, { companyId: A, days: 5 });

    const { body } = await call();
    const row = body.campaigns.rows[0];

    expect(row.destination.template).toBe("/marketing/campaigns/plans/:campaignPlanId/performance");
    expect(row.destination.path).toBe(
      `/marketing/campaigns/plans/${encodeURIComponent(row.campaignPlanId)}/performance`,
    );

    /* ── AND THE SAME IDENTIFIER THE OTHER ROUTES TAKE ───────────────────
       The link is not a second encoding of the plan: it is the token this
       response already published, so a client passes through what it was
       given rather than building anything. */
    expect(row.destination.path).toContain(encodeURIComponent(row.campaignPlanId));

    /* The one attention item about a campaign resolves the same way, from the
       identifier in its own evidence. */
    const best = body.attention.find((a) => a.code === "best_cost_per_conversion");
    if (best) {
      expect(best.destination.path).toBe(
        `/marketing/campaigns/plans/${encodeURIComponent(best.evidence.campaignPlanId)}/performance`,
      );
    }
  });

  test("32. every destination names a route the frontend actually serves", () => {
    if (!frontendPresent) {
      throw new Error(
        `The frontend checkout was not found at ${FRONTEND}. This assertion is the one that stops a destination drifting from the screen it names, so it fails loudly rather than passing without checking anything.`,
      );
    }

    for (const spec of Object.values(vocabulary.DESTINATIONS)) {
      expect({ code: spec.code, path: spec.path, served: serves(spec.path) })
        .toEqual({ code: spec.code, path: spec.path, served: true });
    }
  });

  test("33. the old campaign address is gone, and is not served either", () => {
    const flat = JSON.stringify(vocabulary.DESTINATIONS);
    expect(flat).not.toContain("/marketing/campaigns/:campaignPlanId");

    if (frontendPresent) {
      /* Belt and braces: if somebody adds that route later, the destination
         table is still the thing that decides — but the assertion above would
         then pass for a second reason, so this records why it was wrong. */
      expect(serves("/marketing/campaigns/:campaignPlanId")).toBe(false);
    }
  });

  test("34. a templated destination without its identifier is refused, not published", () => {
    expect(() => vocabulary.destinationFor("campaign")).toThrow(/needs a campaignPlanId/);
    expect(() => vocabulary.destinationFor("campaign", { campaignPlanId: "  " })).toThrow(/needs a campaignPlanId/);
    expect(() => vocabulary.destinationFor("nope")).toThrow(/Unknown marketing destination/);

    /* A destination with no parameter resolves to itself. */
    const list = vocabulary.destinationFor("campaigns");
    expect(list.path).toBe(list.template);
  });

  test("35. no overview source spells a screen address by hand", () => {
    /* One table owns them. Spelling `/marketing/handovers` inline is how the
       campaign path drifted from its route without anything noticing. */
    const dir = path.resolve(__dirname, "../../services/marketing/overview");
    for (const name of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      const literals = src.match(/["'`]\/marketing[^"'`]*["'`]/g) || [];
      expect({ name, literals }).toEqual({ name, literals: [] });
    }

    const constants = fs.readFileSync(
      path.resolve(__dirname, "../../constants/marketingOverview.js"), "utf8",
    );
    /* And the table itself holds exactly three. */
    const declared = (constants.match(/path: [`"]\/marketing/g) || []).length;
    expect(declared).toBe(3);
  });
});
