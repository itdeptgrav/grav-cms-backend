// services/marketing/performance/campaignReport.service.js
//
// WHAT A CAMPAIGN PLAN DID, TURNED INTO SOMETHING A PERSON CAN READ.
//
// ── IT READS GRAV, AND NOTHING ELSE ────────────────────────────────────────
// No advertising channel is contacted here. This assembles observations the
// sync service already wrote, so opening a report is free, repeatable and
// unaffected by whether a channel happens to be answering. Refreshing is a
// separate, explicit act.
//
// ── THE FOUR WAYS A REPORT LIES, AND WHAT STOPS EACH ───────────────────────
//
//   A missing figure rendered as zero. Every metric here is null unless a
//   channel reported it, and a null survives to the response with a reason
//   beside it.
//
//   A partial day summed into a total. Totals count only `complete` days. The
//   partial ones are still shown in the daily series — hiding them would be its
//   own lie — but they are labelled and excluded from the figure somebody
//   compares month on month.
//
//   A ratio with an invalid denominator. A campaign with no impressions has no
//   click-through rate; it does not have a rate of zero. Each ratio is computed
//   only when both inputs are known and the denominator is above zero, and
//   otherwise says why it is absent.
//
//   Two channels added together when they should not be. Impressions add.
//   Spend adds only in one currency. Reach never adds — the same person can be
//   reached on both — and conversions never add, because each channel decides
//   for itself what one is.
//
// ── AND NOTHING PROVIDER-SHAPED LEAVES ─────────────────────────────────────
// No account identifier, no external campaign id, no database id, no provider
// error text, no internal reconciliation stage. A reader is told which channel,
// what happened, and how fresh it is.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignObservation,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const {
  METRICS,
  METRIC_BY_CODE,
  COMPLETENESS,
  COUNTING_COMPLETENESS,
  INCOMPLETE_REASONS,
  FRESHNESS,
  DERIVED_RATIOS,
  COMBINATION_RULES,
  MONEY,
  RANGE,
  RAW_RESPONSE_POLICY,
  PERFORMANCE_CODES: C,
} = require("../../../constants/marketingPerformance");

const str = (v) => String(v ?? "").trim();

const COMPLETENESS_BY_CODE = Object.fromEntries(COMPLETENESS.map((c) => [c.code, c]));
const REASON_BY_CODE = Object.fromEntries(INCOMPLETE_REASONS.map((r) => [r.code, r]));

const CHANNEL_LABEL = Object.freeze({ google_ads: "Google Ads", meta_ads: "Meta Ads" });

/* ── ADDING NULLABLE NUMBERS ────────────────────────────────────────────────
   The rule that keeps "nobody told us" out of a total: null plus anything is
   still the running value, and a total stays null until at least one real
   figure has landed in it. A total of 0 therefore means the channels reported
   zero, not that nothing was reported. */
const add = (running, value) => {
  if (value === null || value === undefined) return running;
  return (running === null ? 0 : running) + value;
};

/* ── A RATIO, OR THE REASON THERE ISN'T ONE ─────────────────────────────────
   Three ways a ratio can fail to exist, and they are different things a reader
   needs told apart: an input nobody reported, a denominator of zero, and a
   denominator that is legitimately zero because the campaign did not run. */
function ratio(spec, totals, currency) {
  const numerator = totals[spec.numerator];
  const denominator = totals[spec.denominator];

  if (numerator === null || denominator === null) {
    const missing = numerator === null ? spec.numerator : spec.denominator;
    return {
      code: spec.code,
      label: spec.label,
      value: null,
      available: false,
      why: `GRAV does not know the ${METRIC_BY_CODE[missing].label.toLowerCase()} for this period, so it cannot work this out.`,
    };
  }
  if (denominator <= 0) {
    return {
      code: spec.code,
      label: spec.label,
      value: null,
      available: false,
      why: spec.undefinedWhenZeroDenominator,
    };
  }

  /* Money numerators are held in micros for precision and presented in minor
     units. The division happens in micros and is rounded once. */
  const isMoney = METRIC_BY_CODE[spec.numerator].kind === "money";
  const value = isMoney
    ? Math.round((numerator / denominator) / MONEY.MICROS_PER_MINOR_UNIT * 100) / 100
    : Math.round((numerator / denominator) * 1000000) / 1000000;

  return {
    code: spec.code,
    label: spec.label,
    value,
    available: true,
    means: spec.means,
    ...(isMoney ? { currency, unit: "minor_units" } : { format: "ratio" }),
  };
}

/* ── ONE DEPLOYMENT'S TOTALS ────────────────────────────────────────────────
   Built from `complete` days only. The partial and unavailable ones are counted
   separately so the response can say exactly how much of the window is settled
   rather than leaving a reader to infer it from a shorter-than-expected total. */
function totalsFrom(observations) {
  const counting = observations.filter((o) => COUNTING_COMPLETENESS.includes(o.completeness));

  const totals = {
    impressions: null,
    reach: null,
    clicks: null,
    landingPageViews: null,
    /* Summed in micros; converted once below. */
    spend: null,
    conversions: null,
    conversionValue: null,
  };

  for (const o of counting) {
    totals.impressions = add(totals.impressions, o.impressions);
    totals.clicks = add(totals.clicks, o.clicks);
    totals.landingPageViews = add(totals.landingPageViews, o.landingPageViews);
    totals.spend = add(totals.spend, o.spendMicros);
    totals.conversions = add(totals.conversions, o.conversions);
    totals.conversionValue = add(totals.conversionValue, o.conversionValueMicros);
    /* ── REACH IS NOT SUMMED ACROSS DAYS EITHER ──────────────────────────
       The same person reached on Monday and Tuesday is one person, and no
       channel's daily rows say which. Adding them would invent an audience.
       The period's reach is a figure only the channel can give, and neither
       gives it per-plan, so GRAV reports the largest single day it saw and says
       that is what it is. */
    if (o.reach !== null && o.reach !== undefined) {
      totals.reach = totals.reach === null ? o.reach : Math.max(totals.reach, o.reach);
    }
  }

  return { totals, countingDays: counting.length };
}

/* ── THE DAILY SERIES ───────────────────────────────────────────────────────
   Every day in the window, including the ones GRAV could not read — a gap in a
   chart is indistinguishable from a day of zeros, and the two mean opposite
   things. */
const dayView = (o) => ({
  date: o.reportingDate,
  completeness: o.completeness,
  completenessLabel: COMPLETENESS_BY_CODE[o.completeness]?.label || o.completeness,
  countsTowardTotals: COUNTING_COMPLETENESS.includes(o.completeness),
  reason: o.incompleteReason || null,
  reasonMeans: o.incompleteReason ? REASON_BY_CODE[o.incompleteReason]?.label || "" : "",
  impressions: o.impressions ?? null,
  reach: o.reach ?? null,
  clicks: o.clicks ?? null,
  landingPageViews: o.landingPageViews ?? null,
  spendMinorUnits: o.spendMinorUnits ?? null,
  conversions: o.conversions ?? null,
  conversionValueMinorUnits: o.conversionValueMinorUnits ?? null,
  observedAt: o.observedAt,
  /* Rises when a channel revised its own figures for this day. A reader seeing
     a number move can tell it was the channel rather than GRAV. */
  metricRevision: o.metricRevision,
});

/* ── HOW LONG AGO GRAV LOOKED ───────────────────────────────────────────────
   Derived from the newest observation in the window. `never` is its own state:
   an empty chart because nobody has synced and an empty chart because the
   campaign did nothing look identical otherwise. */
function freshnessOf(observations, now = new Date()) {
  const newest = observations.reduce((best, o) => {
    const at = o.observedAt ? new Date(o.observedAt).getTime() : 0;
    return at > best ? at : best;
  }, 0);

  if (!newest) {
    const spec = FRESHNESS.find((f) => f.code === "never");
    return { code: "never", label: spec.label, observedAt: null, ageMinutes: null };
  }

  const ageMinutes = Math.max(0, Math.round((now.getTime() - newest) / 60000));
  const spec = FRESHNESS.find((f) => f.withinMinutes !== null && ageMinutes <= f.withinMinutes)
    || FRESHNESS.find((f) => f.code === "stale");

  return { code: spec.code, label: spec.label, observedAt: new Date(newest), ageMinutes };
}

/* Every date in the window, so a missing day can be shown as missing. */
function* eachDate(from, to) {
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86400000;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertRange({ startDate, endDate }) {
  const today = new Date().toISOString().slice(0, 10);
  const to = str(endDate) || today;
  const from = str(startDate)
    || new Date(Date.parse(`${to}T00:00:00Z`) - (RANGE.DEFAULT_DAYS - 1) * 86400000).toISOString().slice(0, 10);

  for (const [field, value] of [["startDate", from], ["endDate", to]]) {
    if (!DATE_PATTERN.test(value)) {
      throw fail("VALIDATION", "A date must be written as YYYY-MM-DD.", { field });
    }
  }
  if (from > to) {
    throw fail("VALIDATION", "The start of that range is after its end.",
      { field: "startDate", code: C.RANGE_INVALID });
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > RANGE.MAX_DAYS) {
    throw fail("VALIDATION",
      `That range covers ${days} days. GRAV reports on at most ${RANGE.MAX_DAYS} at a time.`,
      { field: "endDate", code: C.RANGE_TOO_LONG });
  }
  return { from, to, days };
}

/**
 * One campaign plan's results, deployment by deployment.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {ObjectId} args.campaignDraftId  the plan's internal id, already resolved
 * @param {string}  [args.startDate]
 * @param {string}  [args.endDate]
 */
async function report({ companyId, campaignDraftId, draftRef = "", startDate, endDate, now = new Date() }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const { from, to, days } = assertRange({ startDate, endDate });

  /* ── EVERY SELECTOR CARRIES THE COMPANY ───────────────────────────────── */
  const deployments = await MarketingCampaignDeployment
    .find({ companyId: company, campaignDraftId })
    .sort({ channel: 1, approvedRevision: -1 })
    .lean();

  const observations = await MarketingCampaignObservation
    .find({
      companyId: company,
      campaignDraftId,
      reportingDate: { $gte: from, $lte: to },
    })
    .sort({ reportingDate: 1 })
    .lean();

  const byDeployment = new Map();
  for (const o of observations) {
    const key = String(o.deploymentId);
    if (!byDeployment.has(key)) byDeployment.set(key, []);
    byDeployment.get(key).push(o);
  }

  const perDeployment = deployments.map((d) => {
    const rows = byDeployment.get(String(d._id)) || [];
    const byDate = new Map(rows.map((r) => [r.reportingDate, r]));

    /* Days GRAV has never read appear as `unavailable` rather than absent. */
    const series = [...eachDate(from, to)].map((date) => {
      const row = byDate.get(date);
      if (row) return dayView(row);
      return {
        date,
        completeness: "unavailable",
        completenessLabel: COMPLETENESS_BY_CODE.unavailable.label,
        countsTowardTotals: false,
        reason: "never_read",
        reasonMeans: REASON_BY_CODE.never_read.label,
        impressions: null, reach: null, clicks: null, landingPageViews: null,
        spendMinorUnits: null, conversions: null, conversionValueMinorUnits: null,
        observedAt: null, metricRevision: null,
      };
    });

    const { totals, countingDays } = totalsFrom(rows);
    const currency = str(rows.find((r) => r.currency)?.currency) || null;
    const timeZone = str(rows.find((r) => r.reportingTimeZone)?.reportingTimeZone) || null;

    /* The conversion definition this channel used, published beside the figure
       so a reader who disagrees can see it rather than guess. */
    const basis = rows.find((r) => r.conversionBasis?.means)?.conversionBasis || null;

    return {
      /* ── NO DATABASE ID, NO ACCOUNT, NO EXTERNAL CAMPAIGN ──────────────
         A caller identifies a deployment by its channel and the revision it
         was of. That is enough to render, and it carries nothing that names
         somebody's advertising account. */
      channel: d.channel,
      channelLabel: CHANNEL_LABEL[d.channel] || d.channel,
      approvedRevision: d.approvedRevision,
      campaignState: d.state,
      currency,
      reportingTimeZone: timeZone,

      totals: {
        impressions: totals.impressions,
        reach: totals.reach,
        reachMeans: totals.reach === null
          ? null
          : "The largest number of people reached on any single day. Daily reach cannot be added up — the same person can be reached on more than one day.",
        clicks: totals.clicks,
        landingPageViews: totals.landingPageViews,
        spendMinorUnits: totals.spend === null ? null : Math.round(totals.spend / MONEY.MICROS_PER_MINOR_UNIT),
        conversions: totals.conversions,
        conversionValueMinorUnits: totals.conversionValue === null
          ? null : Math.round(totals.conversionValue / MONEY.MICROS_PER_MINOR_UNIT),
      },

      derived: DERIVED_RATIOS.map((spec) => ratio(spec, totals, currency)),

      conversionBasis: basis ? { countedTypes: basis.countedTypes || [], means: basis.means } : null,

      coverage: {
        daysRequested: days,
        daysCounted: countingDays,
        daysPartial: series.filter((s) => s.completeness === "partial").length,
        daysUnavailable: series.filter((s) => s.completeness === "unavailable").length,
        means: countingDays === days
          ? "Every day in this range is settled."
          : "Totals cover only the settled days. Days that are still being counted, or that GRAV could not read, are shown in the daily figures and left out of the totals.",
      },

      /* Every reason a day is not settled, once each, with how many days it
         affected — so a reader sees "3 days GRAV could not read" rather than
         scanning a list. */
      gaps: gapsFrom(series),

      freshness: freshnessOf(rows, now),
      daily: series,

      /* Micros kept internally for the combine step below; stripped from the
         published shape. */
      __totals: totals,
    };
  });

  const combined = combine(perDeployment, days);

  const published = perDeployment.map(({ __totals, ...rest }) => rest);

  return {
    campaignPlan: { draftRef: str(draftRef) },
    range: { startDate: from, endDate: to, days },
    deployments: published,
    combined,
    freshness: freshnessOf(observations, now),
    vocabulary: {
      metrics: METRICS.map((m) => ({ code: m.code, label: m.label, means: m.means })),
      completeness: COMPLETENESS.map((c) => ({ code: c.code, label: c.label, means: c.means, countsTowardTotals: c.countsTowardTotals })),
      derived: DERIVED_RATIOS.map((d) => ({ code: d.code, label: d.label, means: d.means })),
    },
    /* Stated rather than implied: opening a report contacts nobody. */
    means: "These are the figures GRAV last read from the advertising channels. Opening this page reads nothing new — use refresh for that.",
    rawResponsesStored: RAW_RESPONSE_POLICY.stored,
  };
}

function gapsFrom(series) {
  const counts = new Map();
  for (const day of series) {
    if (day.countsTowardTotals) continue;
    const code = day.reason || "never_read";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].map(([code, dayCount]) => ({
    code,
    label: REASON_BY_CODE[code]?.label || code,
    completeness: REASON_BY_CODE[code]?.completeness || "unavailable",
    days: dayCount,
  }));
}

/**
 * One figure across several deployments — where that means anything.
 *
 * ── THE METRIC-BY-METRIC ANSWER ────────────────────────────────────────────
 * Not one decision for the whole report. Impressions and clicks add whatever
 * the currencies are. Spend adds only in one currency. Reach and conversions
 * never add, for reasons that have nothing to do with currency: the same person
 * can be reached on both channels, and each channel decides for itself what a
 * conversion is.
 *
 * Every withheld figure carries its reason, because a blank where a total
 * should be is the thing somebody works around by adding the numbers by hand.
 */
function combine(perDeployment, daysRequested) {
  if (perDeployment.length <= 1) {
    return {
      applicable: false,
      means: perDeployment.length
        ? "This plan runs in one advertising channel, so its figures above are the whole picture."
        : "This plan has not been created in any advertising channel.",
      totals: {},
      withheld: [],
    };
  }

  const currencies = [...new Set(perDeployment.map((d) => d.currency).filter(Boolean))];
  const sameCurrency = currencies.length === 1;

  const totals = {};
  const withheld = [];

  for (const [metric, rule] of Object.entries(COMBINATION_RULES)) {
    if (!rule.combinable) {
      withheld.push({ metric, label: METRIC_BY_CODE[metric].label, why: rule.whyNot });
      continue;
    }
    if (rule.requiresSameCurrency && !sameCurrency) {
      /* ── THE FIGURE IS WITHHELD, NOT ESTIMATED ─────────────────────────
         No conversion rate is applied. GRAV has no rate, a rate would be as of
         some moment nobody chose, and a converted total is a number that looks
         like money and is not. */
      withheld.push({
        metric,
        label: METRIC_BY_CODE[metric].label,
        why: rule.whyNot,
        currencies,
      });
      continue;
    }

    let running = null;
    let everyKnown = true;
    for (const d of perDeployment) {
      const value = d.__totals[metric === "spend" || metric === "conversionValue" ? metric : metric];
      if (value === null || value === undefined) { everyKnown = false; continue; }
      running = add(running, value);
    }

    if (!everyKnown) {
      /* ── A PARTIAL SUM IS WORSE THAN NO SUM ────────────────────────────
         Adding the channels GRAV could read and presenting it as the plan's
         total understates it by exactly the amount nobody can see. */
      withheld.push({
        metric,
        label: METRIC_BY_CODE[metric].label,
        why: "GRAV does not have this figure for every channel this plan runs in, so a combined total would understate it.",
      });
      continue;
    }

    const isMoney = METRIC_BY_CODE[metric].kind === "money";
    totals[isMoney ? `${metric}MinorUnits` : metric] = isMoney
      ? Math.round(running / MONEY.MICROS_PER_MINOR_UNIT)
      : running;
  }

  const combinedTotals = { ...totals };
  const derived = DERIVED_RATIOS.map((spec) => {
    /* Derived from the combined figures only where every input survived the
       rules above. */
    const numeratorKey = METRIC_BY_CODE[spec.numerator].kind === "money" ? `${spec.numerator}MinorUnits` : spec.numerator;
    const denominatorKey = METRIC_BY_CODE[spec.denominator].kind === "money" ? `${spec.denominator}MinorUnits` : spec.denominator;
    if (!(numeratorKey in combinedTotals) || !(denominatorKey in combinedTotals)) {
      return {
        code: spec.code,
        label: spec.label,
        value: null,
        available: false,
        why: "One of the figures this needs is not combined across these channels.",
      };
    }
    const denominator = combinedTotals[denominatorKey];
    if (denominator === null || denominator <= 0) {
      return { code: spec.code, label: spec.label, value: null, available: false, why: spec.undefinedWhenZeroDenominator };
    }
    const numerator = combinedTotals[numeratorKey];
    if (numerator === null) {
      return { code: spec.code, label: spec.label, value: null, available: false, why: "One of the figures this needs is not known." };
    }
    const isMoney = METRIC_BY_CODE[spec.numerator].kind === "money";
    return {
      code: spec.code,
      label: spec.label,
      value: isMoney
        ? Math.round((numerator / denominator) * 100) / 100
        : Math.round((numerator / denominator) * 1000000) / 1000000,
      available: true,
      means: spec.means,
      ...(isMoney ? { currency: currencies[0], unit: "minor_units" } : { format: "ratio" }),
    };
  });

  return {
    applicable: true,
    channels: perDeployment.map((d) => d.channelLabel),
    currency: sameCurrency ? currencies[0] : null,
    totals,
    derived,
    withheld,
    daysRequested,
    means: sameCurrency
      ? "Figures that mean the same thing in both channels are added together. The ones that do not are listed below with the reason."
      : "These channels bill in different currencies, so their money figures are not added together. The counts that do add are combined below.",
  };
}

module.exports = { report, __internals: { totalsFrom, ratio, combine, freshnessOf, assertRange } };
