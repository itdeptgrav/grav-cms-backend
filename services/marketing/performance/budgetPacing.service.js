// services/marketing/performance/budgetPacing.service.js
//
// IS THIS CAMPAIGN SPENDING ITS APPROVED BUDGET AT THE RATE ITS SCHEDULE
// IMPLIES? — AND WHEN GRAV CANNOT HONESTLY SAY, WHY NOT.
//
// ── READ-ONLY, AND GRAV-ONLY ───────────────────────────────────────────────
// It reads the approved plan, the deployments GRAV recorded for it and the
// daily observations the sync service already stored. It contacts no
// advertising channel, writes nothing, and changes no campaign or budget.
//
// ── THE CALCULATION ────────────────────────────────────────────────────────
// Stated in constants/marketingPacing.js (and published on every response as
// `calculation`). In short: the unbroken run of settled days from the start
// date gives spend so far and elapsed days; the approved budget and schedule
// give expected spend by then; their ratio gives the verdict.
//
// ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
// Treat an unread day as zero. Add two currencies. Split one plan budget
// between channels. Compare an earlier revision's campaign with today's
// budget. Each of those produces a verdict that looks precise and is invented,
// so each produces `unavailable` and a reason instead.
"use strict";

const mongoose = require("mongoose");

const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignObservation,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const { MONEY } = require("../../../constants/marketingPerformance");
const P = require("../../../constants/marketingPacing");
const { minorUnitDigits } = require("../../../constants/currencyMinorUnits");
const zoned = require("../contentPlan/zonedTime");

const str = (v) => String(v ?? "").trim();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL_LABEL = Object.freeze({ google_ads: "Google Ads", meta_ads: "Meta Ads" });

const VERDICT_BY_CODE = Object.fromEntries(P.VERDICTS.map((v) => [v.code, v]));
const REASON_BY_CODE = Object.fromEntries(P.UNAVAILABLE.map((r) => [r.code, r]));

const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from) + 1;
const addDays = (d, n) => new Date((dayNumber(d) + n) * 86400000).toISOString().slice(0, 10);
const minDate = (a, b) => (a < b ? a : b);

/* ── MONEY IN THE CURRENCY'S OWN MINOR UNIT ───────────────────────────────────
   Micros are millionths of the MAJOR unit in every currency (that is the
   channels' convention). The minor unit is 10^-digits of it, per ISO 4217:
   100 paise, no sen for yen, 1,000 fils for dinar. A currency whose digits GRAV
   does not know gets no money figures at all — see planProblem. */
const microsPerMinor = (digits) => MONEY.MICROS_PER_MAJOR_UNIT / (10 ** digits);
const toMinor = (micros, digits) => Math.round(micros / microsPerMinor(digits));

function unavailable(code, detail = null) {
  const spec = REASON_BY_CODE[code];
  return {
    available: false,
    reason: { code: spec.code, label: spec.label, means: spec.means },
    ...(detail ? { detail } : {}),
  };
}

/* ── THE PLAN ITSELF: IS THERE AN APPROVED BUDGET AND SCHEDULE TO PACE? ──── */
function planProblem(plan) {
  if (str(plan?.state) !== "approved") return unavailable("plan_not_approved", { planState: str(plan?.state) || null });
  const b = plan.budget || null;
  const amountOk = b && typeof b.amount === "number" && Number.isFinite(b.amount) && b.amount >= 0;
  if (!amountOk || !/^[A-Z]{3}$/.test(str(b.currency).toUpperCase()) || !["daily", "total"].includes(str(b.basis))) {
    return unavailable("budget_missing");
  }
  if (b.amount === 0) return unavailable("budget_zero");
  if (minorUnitDigits(b.currency) === null) {
    return unavailable("currency_precision_unsupported", { currency: str(b.currency).toUpperCase() });
  }
  const start = str(plan.schedule?.startDate);
  const end = str(plan.schedule?.endDate);
  if (!DATE.test(start) || !DATE.test(end) || start > end) return unavailable("schedule_missing");
  return null;
}

/* Which basis governs this channel's campaign: the plan's, unless the channel
   brief records an arrangement that contradicts it. */
function basisFor(plan, brief) {
  const basis = str(plan.budget.basis);
  const relationship = str(brief?.budgetRelationship);
  if (relationship === "ad_set_daily") return { problem: "budget_per_audience" };
  if (relationship === "campaign_daily" && basis !== "daily") return { problem: "budget_basis_conflict" };
  if (relationship === "campaign_total" && basis !== "total") return { problem: "budget_basis_conflict" };
  return { basis };
}

/**
 * One deployment's pace, or the specific reason there is none.
 */
/* ── IS THIS CAMPAIGN CONFIRMED RUNNING? ─────────────────────────────────────
   GRAV's record says it was started AND the campaign object was read back
   from the channel as delivering. Never inferred from the schedule or from
   spend. */
function runningEvidence(deployment) {
  if (deployment.state !== P.RUNNING_DEPLOYMENT_STATE) return false;
  const words = P.DELIVERING_OBSERVED_STATES[deployment.channel] || [];
  const campaign = (deployment.externalObjects || []).find((o) => o.role === "campaign");
  return Boolean(campaign)
    && campaign.nonDeliveringConfirmed === false
    && Boolean(campaign.stateReadAt)
    && words.includes(str(campaign.observedState).toUpperCase());
}

function paceDeployment({ plan, deployment, rows, now }) {
  /* A campaign created stopped has no spending pace — even a genuine zero is
     not "under pace". Its measured spend, if any, stays in the report. */
  if (deployment.state === P.STOPPED_DEPLOYMENT_STATE) {
    return unavailable("campaign_stopped", { campaignState: deployment.state, measuredSpendIn: "performance_report" });
  }
  if (deployment.state === P.RUNNING_DEPLOYMENT_STATE && !runningEvidence(deployment)) {
    return unavailable("running_state_unconfirmed", { campaignState: deployment.state });
  }
  if (!runningEvidence(deployment)) {
    return unavailable("campaign_not_created", { campaignState: deployment.state });
  }
  const digits = minorUnitDigits(plan.budget.currency);

  const brief = (plan.deploymentBriefs || []).find((b) => b.channel === deployment.channel) || null;
  const { basis, problem } = basisFor(plan, brief);
  if (problem) return unavailable(problem);

  /* ── THE ACCOUNT'S OWN DAYS ────────────────────────────────────────────
     A day has elapsed when it is over in the advertising account's time
     zone — the zone the channel reports days in. The plan's own brief is the
     fallback before the first observation arrives. */
  const zone = str(rows.find((r) => r.reportingTimeZone)?.reportingTimeZone) || str(brief?.timezone);
  let today;
  try {
    today = zoned.localOf(now.getTime(), zoned.assertTimeZone(zone)).date;
  } catch (_) {
    return unavailable("time_zone_unknown");
  }

  const start = str(plan.schedule.startDate);
  const end = str(plan.schedule.endDate);
  const lastElapsed = minDate(end, addDays(today, -1));
  const scheduleState = today > end ? "ended" : today < start ? "not_started" : "running";
  if (lastElapsed < start) return unavailable("not_started", { startDate: start, timeZone: zone });

  /* ── ONE CURRENCY, THE APPROVED ONE ────────────────────────────────────── */
  const currency = str(plan.budget.currency).toUpperCase();
  const reported = [...new Set(rows.map((r) => str(r.currency).toUpperCase()).filter(Boolean))];
  if (reported.some((c) => c !== currency)) {
    return unavailable("currency_mismatch", { budgetCurrency: currency, reportedCurrencies: reported });
  }

  /* ── THE UNBROKEN RUN OF SETTLED DAYS FROM THE START ──────────────────── */
  const byDate = new Map(rows.map((r) => [r.reportingDate, r]));
  let asOf = null;
  for (let d = start; d <= lastElapsed; d = addDays(d, 1)) {
    if (byDate.get(d)?.completeness === "complete") asOf = d;
    else break;
  }

  /* After it, only days still inside the settling window may follow — each
     read, each still being counted. An unread day is not zero: it stops the
     verdict. */
  const after = [];
  for (let d = asOf ? addDays(asOf, 1) : start; d <= lastElapsed; d = addDays(d, 1)) after.push(d);
  const unread = after.filter((d) => {
    const row = byDate.get(d);
    return !row || row.completeness === "unavailable";
  });
  if (unread.length) {
    return unavailable("missing_days", {
      missingDays: unread.length,
      firstMissingDate: unread[0],
      evaluatedThrough: lastElapsed,
    });
  }
  const stillSettling = after.filter((d) => byDate.get(d)?.completeness === "partial").length;
  if (after.length !== stillSettling || stillSettling > P.MAX_UNSETTLED_DAYS) {
    return unavailable("settled_data_behind", { lastSettledDate: asOf, unsettledDays: after.length });
  }
  if (!asOf) return unavailable("no_settled_days", { startDate: start });

  /* ── SPEND SO FAR: REPORTED FIGURES ONLY, ADDED IN MICROS ─────────────── */
  let spentMicros = 0;
  for (let d = start; d <= asOf; d = addDays(d, 1)) {
    const micros = byDate.get(d).spendMicros;
    if (micros === null || micros === undefined || !Number.isFinite(micros)) {
      return unavailable("spend_not_reported", { firstDate: d });
    }
    /* A reported 0 is a real 0 and is added as one. */
    spentMicros += micros;
  }

  const scheduleDays = daysBetween(start, end);
  const elapsedDays = daysBetween(start, asOf);
  const amountMicros = Math.round(plan.budget.amount * MONEY.MICROS_PER_MAJOR_UNIT);
  const expectedMicros = basis === "daily"
    ? amountMicros * elapsedDays
    : Math.round((amountMicros * elapsedDays) / scheduleDays);
  const scheduleBudgetMicros = basis === "daily" ? amountMicros * scheduleDays : amountMicros;

  const paceRatio = spentMicros / expectedMicros;
  const verdictCode = spentMicros > scheduleBudgetMicros ? "over_budget"
    : paceRatio > P.THRESHOLDS.OVER_ABOVE ? "over_pace"
      : paceRatio < P.THRESHOLDS.UNDER_BELOW ? "under_pace"
        : "on_pace";
  const verdict = VERDICT_BY_CODE[verdictCode];

  return {
    available: true,
    verdict: { code: verdict.code, label: verdict.label, means: verdict.means },
    paceRatio: Math.round(paceRatio * 1000) / 1000,
    basis,
    currency,
    timeZone: zone,
    scheduleState,
    asOf,
    elapsedDays,
    scheduleDays,
    stillSettlingDays: stillSettling,
    /* How many decimal places this currency's minor unit has — the unit every
       *MinorUnits figure below is in. */
    minorUnitDigits: digits,
    spentToDateMinorUnits: toMinor(spentMicros, digits),
    expectedToDateMinorUnits: toMinor(expectedMicros, digits),
    scheduleBudgetMinorUnits: toMinor(scheduleBudgetMicros, digits),
    remainingBudgetMinorUnits: toMinor(Math.max(0, scheduleBudgetMicros - spentMicros), digits),
    overBudgetMinorUnits: toMinor(Math.max(0, spentMicros - scheduleBudgetMicros), digits),
  };
}

const vocabulary = Object.freeze({
  verdicts: P.VERDICTS.map((v) => ({ code: v.code, label: v.label, means: v.means })),
  unavailable: P.UNAVAILABLE.map((r) => ({ code: r.code, label: r.label, means: r.means })),
  thresholds: { underBelow: P.THRESHOLDS.UNDER_BELOW, overAbove: P.THRESHOLDS.OVER_ABOVE },
  maxStillSettlingDays: P.MAX_UNSETTLED_DAYS,
});

/**
 * The pacing result for one approved campaign plan.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId  the caller's company
 * @param {object}   args.plan       the plan, already loaded company-scoped
 * @param {Date}    [args.now]
 */
async function pacing({ companyId, plan, now = new Date() } = {}) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  /* The approved amount in the currency's own minor unit — or null, with
     `minorUnitDigits: null`, when GRAV does not know that unit. Never a figure
     in an assumed one. */
  const digits = plan.budget ? minorUnitDigits(plan.budget.currency) : null;
  const budget = plan.budget
    ? {
      amountMinorUnits: typeof plan.budget.amount === "number" && digits !== null
        ? Math.round(plan.budget.amount * (10 ** digits)) : null,
      minorUnitDigits: digits,
      currency: str(plan.budget.currency).toUpperCase() || null,
      basis: str(plan.budget.basis) || null,
    }
    : null;

  const base = {
    campaignPlan: {
      draftRef: str(plan.draftRef),
      state: str(plan.state),
      /* The revision whose budget is compared — only an approved one is. */
      approvedRevision: str(plan.state) === "approved" ? plan.revision : null,
    },
    budget,
    schedule: { startDate: str(plan.schedule?.startDate) || null, endDate: str(plan.schedule?.endDate) || null },
    calculation: P.CALCULATION,
    vocabulary,
    means: "Read from GRAV's stored results. Opening this contacts no advertising channel and changes nothing; refresh the campaign's results to bring the figures up to date.",
    readsAdvertisingChannels: false,
    canChangeBudget: false,
    canChangeCampaign: false,
  };

  const problem = planProblem(plan);
  if (problem) return { ...base, pacing: problem, deployments: [] };

  /* ── EVERY SELECTOR LEADS WITH THE COMPANY ────────────────────────────── */
  const deployments = await MarketingCampaignDeployment
    .find({ companyId: company, campaignDraftId: plan._id })
    /* The campaign object's read-back state is the running evidence. The
       provider's own identifier is not selected. */
    .select("channel approvedRevision state externalObjects.role externalObjects.nonDeliveringConfirmed externalObjects.stateReadAt externalObjects.observedState")
    .sort({ channel: 1, approvedRevision: -1 })
    .lean();

  const current = deployments.filter((d) => d.approvedRevision === plan.revision);
  const earlier = deployments.filter((d) => d.approvedRevision !== plan.revision);

  const rows = current.length
    ? await MarketingCampaignObservation
      .find({
        companyId: company,
        campaignDraftId: plan._id,
        approvedRevision: plan.revision,
        deploymentId: { $in: current.map((d) => d._id) },
        reportingDate: { $gte: str(plan.schedule.startDate), $lte: str(plan.schedule.endDate) },
      })
      .select("deploymentId reportingDate reportingTimeZone currency completeness spendMicros")
      .lean()
    : [];

  const byDeployment = new Map();
  for (const r of rows) {
    const key = String(r.deploymentId);
    if (!byDeployment.has(key)) byDeployment.set(key, []);
    byDeployment.get(key).push(r);
  }

  const views = [
    ...current.map((d) => ({
      channel: d.channel,
      channelLabel: CHANNEL_LABEL[d.channel] || d.channel,
      approvedRevision: d.approvedRevision,
      campaignState: d.state,
      pacing: paceDeployment({ plan, deployment: d, rows: byDeployment.get(String(d._id)) || [], now }),
    })),
    ...earlier.map((d) => ({
      channel: d.channel,
      channelLabel: CHANNEL_LABEL[d.channel] || d.channel,
      approvedRevision: d.approvedRevision,
      campaignState: d.state,
      pacing: unavailable("revision_changed", { campaignRevision: d.approvedRevision, approvedRevision: plan.revision }),
    })),
  ];

  /* ── THE PLAN'S OWN ANSWER ────────────────────────────────────────────────
     One current campaign: its pace is the plan's. Several: each is paced on
     its own and none is added to another — the plan records no split of its
     budget between them. None for this revision: say which case it is. */
  let planPacing;
  if (current.length === 1) planPacing = views[0].pacing;
  else if (current.length > 1) planPacing = unavailable("several_campaigns", { channels: current.map((d) => d.channel) });
  else if (earlier.length) planPacing = unavailable("revision_changed", { approvedRevision: plan.revision });
  else planPacing = unavailable("not_deployed");

  return { ...base, pacing: planPacing, deployments: views };
}

module.exports = { pacing, vocabulary, __internals: { paceDeployment, planProblem, basisFor, runningEvidence, toMinor } };
