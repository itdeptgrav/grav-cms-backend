// services/marketing/overview/marketingOverview.service.js
//
// ONE HONEST BUSINESS SUMMARY OF A COMPANY'S MARKETING.
//
// ── READ-ONLY, AND STRUCTURALLY SO ─────────────────────────────────────────
// This file imports no provider client, no HTTP client, no deployment writer,
// no AI client and no Mautic client. It cannot contact an advertising channel,
// cannot create anything, and cannot ask a model for an opinion. Everything it
// publishes is read from records GRAV already holds, and a test walks its
// imports to keep that true.
//
// ── IT ALSO OWNS ALMOST NO RULES ───────────────────────────────────────────
// Completeness, money, combinability and the derived ratios belong to the
// performance contract. Handover counts belong to the handover read model.
// What counts as engagement belongs to the marketing constants. This file
// gathers and words; it does not decide.
//
// ── THE VOCABULARY IS THE MARKETER'S ───────────────────────────────────────
// No synchronisation, retry, reconciliation, mapping, engine, credential,
// queue, provider or database language reaches this response — not because
// those things are secret, but because none of them is something a marketer
// opening `/marketing` can act on, and every one of them invites a support
// ticket about something that is working correctly.
"use strict";

const mongoose = require("mongoose");

const { MarketingCampaignDraft } = require("../../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const { MarketingCampaignDeployment } = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const { MarketingCampaignObservation } = require("../../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const { fail } = require("../../storePurchase/errors");

const identity = require("../campaignDrafts/draftIdentity");
const report = require("../performance/campaignReport.service");
const { performanceFor, measured, unknown } = require("./overviewPerformance");
const { movementFor } = require("./overviewMovement");

const {
  METRIC_BY_CODE,
  DERIVED_RATIOS,
  COMBINATION_RULES,
  MONEY,
  COUNTING_COMPLETENESS,
} = require("../../../constants/marketingPerformance");
const {
  RANGE,
  METRIC_UNITS,
  CONFIRMED_DEPLOYMENT_STATES,
  DEPLOYMENT_STATUS_BY_STATE,
  APPROVED_NOT_DEPLOYED,
  ATTENTION_BY_CODE,
  destinationFor,
  AVAILABILITY_SOURCES,
} = require("../../../constants/marketingOverview");

const { assertRange, freshnessOf } = report.__internals;

const CHANNEL_LABEL = Object.freeze({ google_ads: "Google Ads", meta_ads: "Meta Ads" });
const str = (v) => String(v ?? "").trim();

function assertCompany(companyId) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "The Marketing overview cannot be read without a company.");
  }
  return companyId;
}

/**
 * The range this overview covers.
 *
 * ── DEFAULTS TO THE LAST 30 *FINISHED* DAYS ───────────────────────────────
 * Ending yesterday. Today is always partial — no advertising channel has
 * finished counting it — and the performance contract already excludes a
 * partial day from every total. A default ending today would open the page on
 * a period whose last day is guaranteed to be left out, so a reader comparing
 * two "last 30 days" would be comparing 29 settled days against 30.
 *
 * Validation itself is delegated to the performance contract's own
 * `assertRange`, so format, ordering and the maximum length cannot drift apart
 * from the campaign report's.
 */
function rangeFor({ from, to } = {}) {
  const supplied = { startDate: str(from), endDate: str(to) };

  if (!supplied.endDate && !supplied.startDate) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    supplied.endDate = yesterday;
    supplied.startDate = new Date(Date.parse(`${yesterday}T00:00:00Z`)
      - (RANGE.DEFAULT_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  }

  const { from: start, to: end, days } = assertRange({
    startDate: supplied.startDate,
    endDate: supplied.endDate,
  });
  return { from: start, to: end, days, defaulted: !str(from) && !str(to) };
}

/* ── ONE CAMPAIGN ROW ───────────────────────────────────────────────────────
   Identified by its SIGNED plan identifier, so a screen can link to it without
   the response ever carrying a database id. Nothing here names an advertising
   account or an external campaign. */
function campaignRow({ deployment, plan, totals, countingDays, currency, daysRequested, conversionBasis, campaignPlanId }) {
  const status = DEPLOYMENT_STATUS_BY_STATE[deployment.state] || null;

  const spend = totals.spend === null
    ? unknown(METRIC_UNITS.MINOR_UNITS, "The advertising channel did not report what it charged for these dates.")
    : measured(Math.round(totals.spend / MONEY.MICROS_PER_MINOR_UNIT), METRIC_UNITS.MINOR_UNITS, { currency });

  const clicks = totals.clicks === null
    ? unknown(METRIC_UNITS.COUNT, "The advertising channel did not report clicks for these dates.")
    : measured(totals.clicks, METRIC_UNITS.COUNT);

  const impressions = totals.impressions === null
    ? unknown(METRIC_UNITS.COUNT, "The advertising channel did not report how often it was shown for these dates.")
    : measured(totals.impressions, METRIC_UNITS.COUNT);

  const conversions = totals.conversions === null
    ? unknown(METRIC_UNITS.DECIMAL, "The advertising channel did not report conversions for these dates.")
    : measured(Math.round(totals.conversions * 1000000) / 1000000, METRIC_UNITS.DECIMAL);

  /* The existing ratio rule, over this campaign's own totals. A ratio over a
     zero denominator does not exist and is not zero. */
  const derived = Object.fromEntries(DERIVED_RATIOS.map((spec) => {
    const r = report.__internals.ratio(spec, totals, currency);
    return [spec.code, r.available
      ? measured(r.value, METRIC_BY_CODE[spec.numerator].kind === "money"
        ? METRIC_UNITS.MINOR_UNITS : METRIC_UNITS.RATIO,
      { means: r.means, ...(r.currency ? { currency: r.currency } : {}) })
      : unknown(METRIC_BY_CODE[spec.numerator].kind === "money"
        ? METRIC_UNITS.MINOR_UNITS : METRIC_UNITS.RATIO, r.why)];
  }));

  return {
    /* Signed by the caller, which holds the signing env, and passed in rather
       than patched on afterwards — the row's own destination is built from it. */
    campaignPlanId,
    draftRef: str(plan?.draftRef),
    name: str(plan?.name),
    objective: str(plan?.objective) || null,
    channel: deployment.channel,
    channelLabel: CHANNEL_LABEL[deployment.channel] || deployment.channel,
    approvedRevision: deployment.approvedRevision,

    /* GRAV's own words for what this campaign is doing. Never the provider's,
       and never "active" unless the record says activated. */
    status: status ? status.code : "unknown",
    statusLabel: status ? status.label : "Unknown",
    statusMeans: status ? status.means : "GRAV cannot tell what this campaign is doing.",
    delivering: deployment.state === "activated",

    currency: currency || null,
    spend,
    impressions,
    clicks,
    conversions,
    ctr: derived.ctr,
    cpc: derived.cpc,
    cpa: derived.cpa,
    conversionBasis: conversionBasis
      ? { countedTypes: conversionBasis.countedTypes || [], means: conversionBasis.means }
      : null,

    completeness: {
      daysRequested,
      daysCounted: countingDays,
      complete: countingDays === daysRequested,
      measured: countingDays > 0,
      means: countingDays === 0
        ? "GRAV has no settled figures for this campaign in these dates."
        : countingDays === daysRequested
          ? "Every day in this range is settled."
          : "Some days in this range are still being counted or could not be read. They are left out of these totals.",
    },
    /* ── A LINK, NOT A TEMPLATE ──────────────────────────────────────────
       Resolved against this row's own signed identifier, so a client opens
       it unaltered. It used to publish the bare template — and a template
       that reaches a browser is a link that 404s. */
    destination: destinationFor("campaign", { campaignPlanId }),
  };
}

/* ── RANKING, ONLY WHERE A RANKING MEANS SOMETHING ──────────────────────────
   Campaigns are ordered by cost per conversion, lowest first — but only among
   those where it exists AND that share a currency. Ranking a rupee campaign
   against a dollar one by cost orders them by exchange rate, and ranking a
   campaign with no conversions as "worst" states a conclusion the absence of a
   ratio cannot support.

   Everything that cannot be ranked keeps its place after the ranked ones and
   is marked `ranked: false`, so a screen shows it rather than hiding it. */
function rank(rows) {
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  const comparable = currencies.length === 1;

  const rankable = comparable ? rows.filter((r) => r.cpa.available) : [];
  const rest = rows.filter((r) => !rankable.includes(r));

  rankable.sort((a, b) => a.cpa.value - b.cpa.value);

  return {
    rows: [
      ...rankable.map((r, i) => ({ ...r, ranked: true, rank: i + 1 })),
      ...rest.map((r) => ({ ...r, ranked: false, rank: null })),
    ],
    rankedBy: rankable.length ? "cpa" : null,
    rankedByLabel: rankable.length ? "Cost per conversion, lowest first" : null,
    why: rankable.length
      ? "Only campaigns with a cost per conversion in the same currency are ranked. The rest are listed after them."
      : comparable
        ? "No campaign in these dates has a cost per conversion, so there is nothing to rank by."
        : COMBINATION_RULES.spend.whyNot,
  };
}

/* ── WHAT THE OVERVIEW MAY SAY ──────────────────────────────────────────────
   Every item is reproducible from figures in the same response. Nothing is
   generated, predicted, or phrased as advice, and no model is asked anything —
   this function is pure and takes only the data already assembled. */
function attentionFrom({ performance, campaigns, movement, approvedNotDeployed, anyDeployment }) {
  const items = [];
  /* Each item's destination is resolved with the identifier its own evidence
     carries, so every link in the list is usable as published. */
  const push = (code, detail, evidence, destination) => {
    const spec = ATTENTION_BY_CODE[code];
    items.push({
      code: spec.code,
      title: spec.label,
      detail,
      tone: spec.tone,
      evidence,
      destination: destinationFor(destination || spec.destination, {
        campaignPlanId: evidence?.campaignPlanId,
      }),
    });
  };

  if (!anyDeployment) {
    push("no_campaigns_created",
      "No plan has been created in an advertising channel yet, so there are no figures to show.",
      { confirmedCampaigns: 0 });
  } else if (!performance.coverage.daysCounted) {
    push("no_performance_measured",
      "GRAV has no settled advertising figures for these dates. That is not the same as a period in which nothing happened.",
      { daysRequested: performance.coverage.daysRequested, daysCounted: 0 });
  } else if (!performance.coverage.complete) {
    push("performance_partial",
      `${performance.coverage.daysCounted} of ${performance.coverage.daysRequested} days are settled. The rest are shown in the daily figures and left out of the totals.`,
      {
        daysRequested: performance.coverage.daysRequested,
        daysCounted: performance.coverage.daysCounted,
        daysPartial: performance.coverage.daysPartial,
        daysUnavailable: performance.coverage.daysUnavailable,
      });
  }

  if (!performance.spend.available && performance.withheld.some((w) => w.metric === "spend")) {
    push("spend_not_combinable",
      "Campaigns in these dates bill in more than one currency, so GRAV does not show a single spend figure. Each campaign's own spend is below.",
      { currencies: performance.withheld.find((w) => w.metric === "spend")?.currencies || [] });
  }

  /* ── THE BEST-PERFORMING CAMPAIGN, WHERE "BEST" IS DEFINED ──────────── */
  const best = campaigns.rows.find((r) => r.ranked && r.rank === 1);
  if (best) {
    push("best_cost_per_conversion",
      `"${best.name}" has the lowest cost per conversion of the campaigns that have one.`,
      { campaignPlanId: best.campaignPlanId, cpa: best.cpa.value, currency: best.currency });
  }

  if (approvedNotDeployed.length) {
    push("approved_awaiting_creation",
      `${approvedNotDeployed.length} approved ${approvedNotDeployed.length === 1 ? "plan has" : "plans have"} nothing created in an advertising channel yet. ${APPROVED_NOT_DEPLOYED.means}`,
      { plans: approvedNotDeployed.length });
  }

  const stageCount = (code) => movement.prospectMovement.stages.find((s) => s.code === code)?.count || 0;

  if (stageCount("awaiting_review")) {
    push("handovers_awaiting_review",
      `${stageCount("awaiting_review")} ${stageCount("awaiting_review") === 1 ? "prospect is" : "prospects are"} waiting for a Sales decision.`,
      { count: stageCount("awaiting_review") });
  }
  if (stageCount("returned")) {
    push("handovers_returned_for_nurture",
      `${stageCount("returned")} ${stageCount("returned") === 1 ? "prospect was" : "prospects were"} returned for nurture and can be worked on again.`,
      { count: stageCount("returned") });
  }
  if (stageCount("blocked")) {
    push("handovers_blocked",
      `${stageCount("blocked")} ${stageCount("blocked") === 1 ? "prospect" : "prospects"} could not be submitted to Sales. Each has a recorded reason.`,
      { count: stageCount("blocked") });
  }

  return items;
}

/**
 * The Marketing overview.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {string}  [args.from]  YYYY-MM-DD
 * @param {string}  [args.to]    YYYY-MM-DD
 */
async function overview({ companyId, from, to, now = new Date(), env = process.env } = {}) {
  assertCompany(companyId);
  const company = new mongoose.Types.ObjectId(String(companyId));
  const range = rangeFor({ from, to });

  /* ── EVERY SELECTOR CARRIES THE COMPANY ───────────────────────────────── */
  const deployments = await MarketingCampaignDeployment
    .find({ companyId: company, state: { $in: CONFIRMED_DEPLOYMENT_STATES } })
    .sort({ createdAt: 1 })
    .lean();

  const planIds = [...new Set(deployments.map((d) => String(d.campaignDraftId)))];
  const plans = planIds.length
    ? await MarketingCampaignDraft.find({
      companyId: company,
      _id: { $in: planIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean()
    : [];
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  /* Approved plans with nothing created. Approval is not deployment, and an
     overview that counted them as campaigns would report spend-capable
     campaigns that do not exist. */
  const approvedPlans = await MarketingCampaignDraft
    .find({ companyId: company, state: "approved" })
    .select({ _id: 1, draftRef: 1, name: 1 })
    .lean();
  const deployedPlanIds = new Set(planIds);
  const approvedNotDeployed = approvedPlans.filter((p) => !deployedPlanIds.has(String(p._id)));

  const perf = await performanceFor({
    companyId: company, deployments, from: range.from, to: range.to, days: range.days, now,
  });

  const movement = await movementFor({ companyId: company, from: range.from, to: range.to });

  /* One row per confirmed deployment, each signed for navigation. */
  const rows = perf.__perDeployment.map((p) => {
    /* Signed FIRST, because the row's destination is resolved with it — a row
       whose identifier arrived after its link would publish the template. */
    const campaignPlanId = identity.encodeDraftId(
      { companyId: String(company), draftId: String(p.deployment.campaignDraftId) }, env,
    );
    return campaignRow({
      deployment: p.deployment,
      plan: planById.get(String(p.deployment.campaignDraftId)),
      totals: p.totals,
      countingDays: p.countingDays,
      currency: p.currency,
      daysRequested: range.days,
      conversionBasis: p.conversionBasis,
      campaignPlanId,
    });
  });

  const campaigns = rank(rows);

  const attention = attentionFrom({
    performance: perf.performance,
    campaigns,
    movement,
    approvedNotDeployed,
    anyDeployment: deployments.length > 0,
  });

  /* ── WHAT A SCREEN NEEDS TO KNOW ABOUT MISSING DATA ───────────────────────
     Business-shaped, and deliberately silent about why GRAV has nothing: a
     marketer can act on "no figures yet", and cannot act on anything further
     in. */
  const availability = {
    campaignPerformance: perf.__anyMeasured,
    engagement: movement.__anyEngagement,
    handovers: movement.__anyHandovers,
    partial: !perf.performance.coverage.complete && perf.__anyMeasured,
    means: AVAILABILITY_SOURCES.map((s) => ({
      code: s.code,
      label: s.label,
      available: s.code === "campaignPerformance" ? perf.__anyMeasured
        : s.code === "engagement" ? movement.__anyEngagement : movement.__anyHandovers,
      means: (s.code === "campaignPerformance" ? perf.__anyMeasured
        : s.code === "engagement" ? movement.__anyEngagement : movement.__anyHandovers)
        ? s.whenAvailable : s.whenUnavailable,
    })),
  };

  return {
    range: {
      from: range.from,
      to: range.to,
      days: range.days,
      defaulted: range.defaulted,
      /* Published because a date range without one is ambiguous. It is the
         advertising account's own reporting timezone where GRAV has read one,
         and `null` where it has read nothing rather than a guess. */
      timeZone: perf.__timeZone,
      timeZoneMeans: perf.__timeZone
        ? "Dates are the advertising account's own reporting days."
        : "GRAV has read no advertising figures for these dates, so there is no reporting timezone to state.",
      means: range.defaulted ? RANGE.means : "The dates you asked for.",
    },

    performance: perf.performance,
    dailyTrend: perf.dailyTrend,
    campaigns,
    prospectMovement: movement.prospectMovement,
    handoverSummary: movement.handoverSummary,
    attention,
    availability,

    approvedNotDeployed: {
      count: approvedNotDeployed.length,
      means: APPROVED_NOT_DEPLOYED.means,
      plans: approvedNotDeployed.map((p) => ({
        campaignPlanId: identity.encodeDraftId(
          { companyId: String(company), draftId: String(p._id) }, env,
        ),
        draftRef: str(p.draftRef),
        name: str(p.name),
      })),
    },

    freshness: perf.performance.freshness,
    means: "What this company's marketing did in these dates, from records GRAV already holds. Opening this page reads nothing new and changes nothing.",
  };
}

module.exports = {
  overview,
  __internals: { rangeFor, rank, attentionFrom, campaignRow, CHANNEL_LABEL },
};
