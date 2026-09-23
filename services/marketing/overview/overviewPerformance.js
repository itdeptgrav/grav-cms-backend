// services/marketing/overview/overviewPerformance.js
//
// COMPANY-WIDE ADVERTISING FIGURES, UNDER THE RULES THAT ALREADY EXIST.
//
// ── THIS FILE OWNS NO ARITHMETIC OF ITS OWN ────────────────────────────────
// `campaignReport.service.js` decides what a settled day is, how money is
// summed, which figures may be added together and when a ratio exists. This
// file gathers a company's deployments instead of one plan's, and hands the
// same decisions to the same code.
//
// ── WHAT GENERALISING FROM ONE PLAN TO ONE COMPANY ACTUALLY CHANGES ────────
// The existing combination rules were written for one plan deployed to several
// CHANNELS. A company overview spans several plans as well, and two of the
// rules have to be read carefully rather than copied:
//
//   Conversions are marked not combinable, and the stated reason is that each
//   channel decides for itself what counts as one. Within a single channel
//   that reason does not apply — two Google campaigns count conversions the
//   same way. So conversions are summed across deployments of ONE channel and
//   withheld the moment a second channel contributes, which is the rule's own
//   reasoning applied to a wider set, not a relaxation of it.
//
//   Spend is combinable only in one currency. Unchanged: several plans billing
//   in rupees add up; add a dollar campaign and the combined figure is
//   withheld rather than converted, because GRAV holds no exchange rate and a
//   converted total is a number that looks like money and is not.
//
// Reach is not published here at all. It cannot be added across days, across
// channels or across plans, and a company-wide reach figure would be an
// invented audience.
"use strict";

const mongoose = require("mongoose");

const { MarketingCampaignObservation } = require("../../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const report = require("../performance/campaignReport.service");
const {
  METRIC_BY_CODE,
  COMPLETENESS,
  COMPLETENESS_CODES,
  COUNTING_COMPLETENESS,
  INCOMPLETE_REASONS,
  DERIVED_RATIOS,
  COMBINATION_RULES,
  MONEY,
} = require("../../../constants/marketingPerformance");
const { METRIC_UNITS } = require("../../../constants/marketingOverview");

const { totalsFrom, freshnessOf } = report.__internals;

const COMPLETENESS_BY_CODE = Object.fromEntries(COMPLETENESS.map((c) => [c.code, c]));
const REASON_BY_CODE = Object.fromEntries(INCOMPLETE_REASONS.map((r) => [r.code, r]));

const str = (v) => String(v ?? "").trim();

/* Every date in the range, so a day GRAV never read is a labelled row rather
   than a gap the reader fills in with zero. */
function* eachDate(from, to) {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

/* ── THE ONE SHAPE EVERY FIGURE IS PUBLISHED IN ─────────────────────────────
   Known, withheld and never-measured all arrive as `{available, value, unit,
   why}`, so a screen renders one component and never interprets a bare null.

   `measured(0)` and `unknown(...)` are separate functions on purpose. A
   measured zero is a fact; an unknown is the absence of one. Collapsing them
   is the single most damaging thing a summary like this can do — "we spent
   nothing" and "we do not know what we spent" lead to opposite decisions. */
const measured = (value, unit, extra = {}) => ({
  available: true, value, unit, ...extra,
});
const unknown = (unit, why, extra = {}) => ({
  available: false, value: null, unit, why, ...extra,
});

/**
 * Company-wide performance for a settled range.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object[]} args.deployments confirmed deployments, already company-scoped
 * @param {string}   args.from        YYYY-MM-DD
 * @param {string}   args.to          YYYY-MM-DD
 * @param {number}   args.days
 */
async function performanceFor({ companyId, deployments, from, to, days, now = new Date() }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const deploymentIds = deployments.map((d) => d._id);

  /* ── EVERY SELECTOR CARRIES THE COMPANY ───────────────────────────────────
     And the deployment list, which is itself company-scoped, so a row can only
     enter this total by belonging to this company twice over. */
  const observations = deploymentIds.length
    ? await MarketingCampaignObservation.find({
      companyId: company,
      deploymentId: { $in: deploymentIds },
      reportingDate: { $gte: from, $lte: to },
    }).sort({ reportingDate: 1 }).lean()
    : [];

  const byDeployment = new Map();
  for (const o of observations) {
    const key = String(o.deploymentId);
    if (!byDeployment.has(key)) byDeployment.set(key, []);
    byDeployment.get(key).push(o);
  }

  /* Per deployment, through the existing totals rule — which filters to
     settled days and treats an absent metric as absent rather than zero. */
  const perDeployment = deployments.map((d) => {
    const rows = byDeployment.get(String(d._id)) || [];
    const { totals, countingDays } = totalsFrom(rows);
    return {
      deployment: d,
      rows,
      totals,
      countingDays,
      channel: d.channel,
      currency: str(rows.find((r) => r.currency)?.currency) || null,
      reportingTimeZone: str(rows.find((r) => r.reportingTimeZone)?.reportingTimeZone) || null,
      conversionBasis: rows.find((r) => r.conversionBasis?.means)?.conversionBasis || null,
    };
  });

  /* Only deployments that actually contributed a settled day can speak to a
     total. One with nothing measured is not a zero contribution — it is not a
     contribution. */
  const contributing = perDeployment.filter((p) => p.countingDays > 0);
  const currencies = [...new Set(contributing.map((p) => p.currency).filter(Boolean))];
  const channels = [...new Set(contributing.map((p) => p.channel))];

  const sumOf = (metric) => {
    let running = null;
    for (const p of contributing) {
      const value = p.totals[metric];
      if (value === null || value === undefined) continue;
      running = running === null ? value : running + value;
    }
    return running;
  };

  /* ── SPEND: EXACT IN MICROS, ROUNDED ONCE ─────────────────────────────── */
  const spendMicros = sumOf("spend");
  const oneCurrency = currencies.length === 1;
  const spend = (() => {
    if (!contributing.length) {
      return unknown(METRIC_UNITS.MINOR_UNITS,
        "GRAV has no settled advertising figures for these dates.");
    }
    if (!oneCurrency && currencies.length > 1) {
      return unknown(METRIC_UNITS.MINOR_UNITS, COMBINATION_RULES.spend.whyNot, { currencies });
    }
    if (spendMicros === null) {
      return unknown(METRIC_UNITS.MINOR_UNITS,
        "The advertising channel did not report what it charged for these dates.");
    }
    return measured(Math.round(spendMicros / MONEY.MICROS_PER_MINOR_UNIT),
      METRIC_UNITS.MINOR_UNITS, { currency: currencies[0] || null });
  })();

  const countMetric = (metric) => {
    if (!contributing.length) {
      return unknown(METRIC_UNITS.COUNT, "GRAV has no settled advertising figures for these dates.");
    }
    const value = sumOf(metric);
    if (value === null) {
      return unknown(METRIC_UNITS.COUNT,
        `The advertising channel did not report ${METRIC_BY_CODE[metric].label.toLowerCase()} for these dates.`);
    }
    return measured(value, METRIC_UNITS.COUNT);
  };

  /* ── CONVERSIONS: ONE CHANNEL'S DEFINITION, OR NONE ───────────────────── */
  const conversions = (() => {
    if (!contributing.length) {
      return unknown(METRIC_UNITS.DECIMAL, "GRAV has no settled advertising figures for these dates.");
    }
    if (channels.length > 1) {
      return unknown(METRIC_UNITS.DECIMAL, COMBINATION_RULES.conversions.whyNot, { channels: channels.length });
    }
    const value = sumOf("conversions");
    if (value === null) {
      return unknown(METRIC_UNITS.DECIMAL, "The advertising channel did not report conversions for these dates.");
    }
    return measured(Math.round(value * 1000000) / 1000000, METRIC_UNITS.DECIMAL, {
      /* The definition travels with the figure, so a reader who disagrees with
         it can see it rather than guess. */
      countedMeans: contributing.find((p) => p.conversionBasis)?.conversionBasis?.means || null,
    });
  })();

  const impressions = countMetric("impressions");
  const clicks = countMetric("clicks");

  /* ── DERIVED: ONLY WHERE BOTH INPUTS SURVIVED ─────────────────────────────
     A ratio over a withheld figure is not a ratio. A denominator of zero is
     not an error and not zero — it is a ratio that does not exist, and the
     existing contract already has the sentence for each case. */
  const ratioOf = (code, numerator, denominator) => {
    const spec = DERIVED_RATIOS.find((r) => r.code === code);
    const isMoney = METRIC_BY_CODE[spec.numerator].kind === "money";
    const unit = isMoney ? METRIC_UNITS.MINOR_UNITS : METRIC_UNITS.RATIO;

    if (!numerator.available || !denominator.available) {
      const missing = !numerator.available ? numerator : denominator;
      return unknown(unit, missing.why || "One of the figures this needs is not available.");
    }
    if (denominator.value <= 0) return unknown(unit, spec.undefinedWhenZeroDenominator);

    const value = isMoney
      ? Math.round((numerator.value / denominator.value) * 100) / 100
      : Math.round((numerator.value / denominator.value) * 1000000) / 1000000;

    return measured(value, unit, {
      means: spec.means,
      ...(isMoney ? { currency: numerator.currency || null } : {}),
    });
  };

  /* ── THE DAILY SERIES ─────────────────────────────────────────────────────
     One row per calendar day, always. A day GRAV never read is `unavailable`
     with its reason, NOT a zero — an empty chart and a chart of zeroes tell a
     reader two different things and only one of them is true. */
  const dayTotals = new Map();
  for (const o of observations) {
    const key = o.reportingDate;
    if (!dayTotals.has(key)) dayTotals.set(key, []);
    dayTotals.get(key).push(o);
  }

  const dailyTrend = [...eachDate(from, to)].map((date) => {
    const rows = dayTotals.get(date) || [];
    if (!rows.length) {
      return {
        date,
        completeness: "unavailable",
        completenessLabel: COMPLETENESS_BY_CODE.unavailable.label,
        countsTowardTotals: false,
        reason: "never_read",
        reasonMeans: REASON_BY_CODE.never_read.label,
        spend: unknown(METRIC_UNITS.MINOR_UNITS, "GRAV has not read this day."),
        clicks: unknown(METRIC_UNITS.COUNT, "GRAV has not read this day."),
        conversions: unknown(METRIC_UNITS.DECIMAL, "GRAV has not read this day."),
      };
    }

    /* A day is only as settled as its least settled row: if one channel's day
       is still being counted, the day's combined figure would change. */
    const worst = rows.some((r) => r.completeness === "unavailable") ? "unavailable"
      : rows.some((r) => r.completeness === "partial") ? "partial" : "complete";
    const counts = COUNTING_COMPLETENESS.includes(worst);
    const dayCurrencies = [...new Set(rows.map((r) => str(r.currency)).filter(Boolean))];
    const dayChannels = [...new Set(rows.map((r) => r.channel))];

    const daySum = (field) => {
      let running = null;
      for (const r of rows) {
        const v = r[field];
        if (v === null || v === undefined) continue;
        running = running === null ? v : running + v;
      }
      return running;
    };

    const micros = daySum("spendMicros");
    const dayClicks = daySum("clicks");
    const dayConversions = daySum("conversions");
    const reasonCode = str(rows.find((r) => r.incompleteReason)?.incompleteReason);

    return {
      date,
      completeness: worst,
      completenessLabel: COMPLETENESS_BY_CODE[worst].label,
      countsTowardTotals: counts,
      reason: reasonCode || null,
      reasonMeans: reasonCode && REASON_BY_CODE[reasonCode] ? REASON_BY_CODE[reasonCode].label : null,
      spend: dayCurrencies.length > 1
        ? unknown(METRIC_UNITS.MINOR_UNITS, COMBINATION_RULES.spend.whyNot)
        : micros === null
          ? unknown(METRIC_UNITS.MINOR_UNITS, "The advertising channel did not report spend for this day.")
          : measured(Math.round(micros / MONEY.MICROS_PER_MINOR_UNIT), METRIC_UNITS.MINOR_UNITS,
            { currency: dayCurrencies[0] || null }),
      clicks: dayClicks === null
        ? unknown(METRIC_UNITS.COUNT, "The advertising channel did not report clicks for this day.")
        : measured(dayClicks, METRIC_UNITS.COUNT),
      conversions: dayChannels.length > 1
        ? unknown(METRIC_UNITS.DECIMAL, COMBINATION_RULES.conversions.whyNot)
        : dayConversions === null
          ? unknown(METRIC_UNITS.DECIMAL, "The advertising channel did not report conversions for this day.")
          : measured(Math.round(dayConversions * 1000000) / 1000000, METRIC_UNITS.DECIMAL),
    };
  });

  const daysCounted = dailyTrend.filter((d) => d.countsTowardTotals).length;

  return {
    performance: {
      spend,
      impressions,
      clicks,
      conversions,
      ctr: ratioOf("ctr", clicks, impressions),
      cpc: ratioOf("cpc", spend, clicks),
      cpa: ratioOf("cpa", spend, conversions),
      currency: oneCurrency ? currencies[0] : null,
      /* Named so a screen can say which figures are withheld and why, without
         inspecting each metric. */
      withheld: [
        ...(currencies.length > 1
          ? [{ metric: "spend", label: METRIC_BY_CODE.spend.label, why: COMBINATION_RULES.spend.whyNot, currencies }]
          : []),
        ...(channels.length > 1
          ? [{ metric: "conversions", label: METRIC_BY_CODE.conversions.label, why: COMBINATION_RULES.conversions.whyNot }]
          : []),
      ],
      coverage: {
        daysRequested: days,
        daysCounted,
        daysPartial: dailyTrend.filter((d) => d.completeness === "partial").length,
        daysUnavailable: dailyTrend.filter((d) => d.completeness === "unavailable").length,
        complete: daysCounted === days,
        means: daysCounted === days
          ? "Every day in this range is settled."
          : "Totals cover only the settled days. Days still being counted, and days GRAV could not read, are shown in the daily figures and left out of the totals.",
      },
      freshness: freshnessOf(observations, now),
    },
    dailyTrend,
    /* For the sections that follow — not published as-is. */
    __perDeployment: perDeployment,
    __contributing: contributing,
    __timeZone: contributing.find((p) => p.reportingTimeZone)?.reportingTimeZone || null,
    __anyMeasured: contributing.length > 0,
  };
}

module.exports = {
  performanceFor,
  eachDate,
  measured,
  unknown,
  __internals: { COMPLETENESS_CODES },
};
