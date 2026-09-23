// services/marketing/channels/campaignPerformance.service.js
//
// WHAT ONE CAMPAIGN COST AND WHAT IT PRODUCED, WITH EVERY CAVEAT ATTACHED.
//
// ── THREE WAYS A NUMBER CAN BE MISSING, AND THEY ARE NOT THE SAME ──────────
// Every published metric is `{ value, state, source }`:
//
//   measured      the channel reported it. It may legitimately be 0.
//   unavailable   the read failed. NOBODY KNOWS. This is not zero.
//   unsupported   this channel does not report this. It never will be zero.
//
// Collapsing these is the single most damaging thing this file could do. A
// campaign whose spend read timed out, rendered as `0`, tells a marketer their
// campaign cost nothing — and the card is still being charged. A campaign with no
// reach figure because Google Ads has no such concept, rendered as `0`, tells
// them nobody saw it.
//
// ── AND EVERY NUMBER SAYS WHO COUNTED IT ───────────────────────────────────
// `provider_reported` is the ad platform's own figure on its own definition.
// `analytics_reported` is a GA4 observation of a browser. `grav_derived` is
// arithmetic on those. Nothing here is `grav_owned`: no GRAV business outcome is
// connected to a campaign yet, so there is no revenue, no opportunity, no ROAS
// and no attribution in this contract. Those arrive when the chain in
// `docs/decisions/marketing-advertising-channel-integration.md` is built and
// proved, link by link.
//
// ── CONVERSIONS ARE NOT ADDED ACROSS CHANNELS ──────────────────────────────
// Google counts conversions on its attribution window; Meta counts a set of
// action types on its own; GA4 counts events it saw. The three measure different
// things, and a total would be a number that is not so much wrong as
// meaningless. Each is published under its own basis, and the response says which
// action types were counted for Meta so a reader can see the definition rather
// than assume one.
"use strict";

const { fail } = require("../../storePurchase/errors");
const {
  METRIC_STATES, METRIC_SOURCES, CONVERSION_BASIS, REPORT_MAX_DAYS,
  channel: channelSpec,
} = require("../../../constants/marketingChannels");
const directory = require("./channelDirectory.service");
const inventory = require("./campaignInventory.service");
const googleAds = require("./googleAdsClient");
const metaAds = require("./metaAdsClient");
const analytics = require("./googleAnalyticsClient");
const dates = require("./channelDates");

const str = (v) => String(v ?? "").trim();

/* A measured number, or a stated absence. `0` is measured; `null` is not. */
const measured = (value, source = "provider_reported") =>
  (value === null || value === undefined || !Number.isFinite(Number(value))
    ? { value: null, state: "unavailable", source }
    : { value: Number(value), state: "measured", source });

const unsupported = (source = "provider_reported") =>
  ({ value: null, state: "unsupported", source });

const unavailable = (source = "provider_reported") =>
  ({ value: null, state: "unavailable", source });

/* Money keeps its currency and the provider's own figure. Never a bare number:
   a spend without its currency is a number somebody will add to a
   differently-denominated one. */
const spendMetric = (moneyValue, source = "provider_reported") => {
  if (!moneyValue) return { value: null, currency: null, state: "unavailable", source };
  return {
    value: moneyValue.amount,
    currency: moneyValue.currency,
    precision: moneyValue.precision,
    providerAmount: moneyValue.providerAmount,
    providerUnit: moneyValue.providerUnit,
    state: "measured",
    source,
  };
};

/**
 * A derived ratio, or a stated absence.
 *
 * ── A DIVISION BY ZERO IS NOT ZERO ─────────────────────────────────────────
 * Cost per click with no clicks is undefined, not 0 and not infinity. A campaign
 * that spent money and got no clicks has no cost-per-click, and publishing one
 * as `0` would make it look like the most efficient campaign in the account.
 */
function ratio(numerator, denominator, source = "grav_derived") {
  if (numerator?.state !== "measured" || denominator?.state !== "measured") {
    /* Inherits the weaker of its inputs. A ratio built on an unavailable figure
       is unavailable, not zero. */
    const worst = [numerator?.state, denominator?.state].includes("unsupported")
      ? "unsupported" : "unavailable";
    return { value: null, state: worst, source };
  }
  if (!Number.isFinite(denominator.value) || denominator.value === 0) {
    return {
      value: null,
      state: "unavailable",
      source,
      /* Said rather than implied: the inputs were fine and the division was not
         possible. A reader must not take this for a failed read. */
      reason: "undefined_no_denominator",
    };
  }
  return { value: numerator.value / denominator.value, state: "measured", source };
}

/* ── THE WINDOW IS EXPLICIT, ALWAYS ─────────────────────────────────────────
   No default range. "Last 28 days" computed server-side means two identical
   requests minutes apart can cover different days, and a figure a marketer wrote
   down yesterday cannot be reproduced today. A caller names the range or is
   refused.

   Delegated to the shared strict validator, which round-trips each date through
   the calendar rather than checking its shape. A pattern alone accepts
   `2026-02-31`, and a provider handed that either rejects it as a malformed
   request GRAV surfaces as an API change, or normalises it into March and
   returns a report labelled February. */
const assertRange = ({ startDate, endDate }) =>
  dates.assertDateRange({ startDate, endDate, maxDays: REPORT_MAX_DAYS });

/**
 * The channel's reporting timezone, read from the account, or null.
 *
 * A best-effort read: its failure must not cost the report, because a figure
 * whose day boundaries are unknown is still a figure worth showing — provided it
 * is not accompanied by a sentence claiming the boundaries are known.
 */
async function timeZoneFor(channel, clients, env) {
  try {
    const client = channel === "google_ads"
      ? (clients.googleAds || googleAds)
      : (clients.metaAds || metaAds);
    const account = await client.verifyAccount(env);
    return str(account?.timeZone) || null;
  } catch (err) {
    console.error(`[marketing-channel] ${channel} reporting timezone unavailable:`,
      str(err?.code) || str(err?.message).slice(0, 200));
    return null;
  }
}

/** A sentence that matches what GRAV actually knows about the timezone. */
const timeZoneNote = (label, timeZone) => (timeZone
  ? `Figures are ${label}' own, in the account's currency and its ${timeZone} timezone.`
  : `Figures are ${label}' own, in the account's currency. GRAV could not read the account's reporting timezone, so the exact day boundaries of this range are unknown and may not match another channel's.`);

/**
 * One campaign's performance.
 *
 * ── THE TIMEZONE IS THE CHANNEL'S, AND IS PUBLISHED ────────────────────────
 * Google Ads reports in the advertising account's timezone. Meta reports in the
 * ad account's. GA4 reports in the property's. A date range means a different
 * set of hours in each, which is why two channels asked for the same week
 * legitimately disagree — and why the timezone travels with every figure instead
 * of being assumed to be the reader's.
 *
 * GRAV does not convert between them. A conversion would need hourly data that
 * none of the three returns at this level, and a converted figure presented as
 * exact would be a fabrication.
 */
async function read({
  companyId, campaignId, startDate, endDate, env = process.env, clients = {},
} = {}) {
  directory.assertCompanyMayRead(companyId, env);

  /* Resolved BEFORE the range is validated and before any provider is touched.
     A forged or foreign id costs one HMAC and reaches no upstream. */
  const resolved = inventory.resolve(campaignId, { companyId, env });
  const { channel, providerCampaignId } = resolved;

  const spec = channelSpec(channel);
  if (!spec?.supports.performance) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      `${spec?.label || channel} does not report campaign performance.`, { channel });
  }

  const range = assertRange({ startDate, endDate });
  const readAt = new Date().toISOString();

  /* ── THE SHAPE IS THE SAME WHETHER THE READ SUCCEEDED OR NOT ─────────────
     Every metric exists in every response, and its `state` carries whether it
     was read. A client therefore renders one shape and never has to guess
     whether an absent key means zero. */
  const blank = (metricSource) => ({
    spend: { value: null, currency: null, state: "unavailable", source: metricSource },
    impressions: unavailable(metricSource),
    reach: unavailable(metricSource),
    clicks: unavailable(metricSource),
    websiteVisits: unavailable("analytics_reported"),
    providerConversions: unavailable(metricSource),
    leads: unavailable("grav_owned"),
    costPerClick: unavailable("grav_derived"),
    costPerLead: unavailable("grav_derived"),
  });

  const envelope = {
    campaignId: str(campaignId),
    channel,
    channelLabel: spec.label,
    dateRange: { startDate: range.startDate, endDate: range.endDate, days: range.days },
    readState: "ok",
    reasonCode: null,
    measuredAt: readAt,
    reportingTimeZone: null,
    metrics: blank(channel === "google_analytics" ? "analytics_reported" : "provider_reported"),
    conversionBasis: null,
    notes: [],
  };

  try {
    if (channel === "google_ads") {
      const client = clients.googleAds || googleAds;
      const report = await client.campaignReport({ providerCampaignId, startDate: range.startDate, endDate: range.endDate }, env);

      const spend = inventory.money({ amount: report.costMicros, currency: report.currency, unit: "micros" });
      const impressions = measured(report.impressions);
      const clicks = measured(report.clicks);

      envelope.metrics = {
        spend: spendMetric(spend),
        impressions,
        /* Google Ads has no reach. Not zero — the concept does not exist in the
           API, and a zero would say Google measured nobody. */
        reach: unsupported(),
        clicks,
        /* Clicks are not website visits. Google bills a click; a visit is what a
           browser did afterwards, and the two differ by everybody who closed the
           tab. GA4 answers this one, not the Ads API. */
        websiteVisits: unsupported("analytics_reported"),
        providerConversions: measured(report.conversions),
        /* A GRAV business outcome. Nothing connects a campaign to a qualified
           prospect yet, so this is unavailable rather than zero — and it is
           labelled `grav_owned` so nobody mistakes a provider conversion for it. */
        leads: unavailable("grav_owned"),
        costPerClick: ratio(spendMetric(spend), clicks),
        costPerLead: unavailable("grav_derived"),
      };
      envelope.conversionBasis = "provider_definition";
      /* ── THE TIMEZONE IS READ, OR IT IS ADMITTED ──────────────────────────
         This used to read a value nothing ever set, leaving `reportingTimeZone`
         null while a note beside it said the figures were in the account's
         timezone. That is a claim GRAV had not established: a reader comparing
         two channels over the same week needs to know the day boundaries, and a
         confident sentence over a null field is worse than no sentence.

         The account read that returns it is the same one the connection check
         performs. Its failure does not cost the report — a figure whose timezone
         is unknown is still worth showing, said plainly. */
      envelope.reportingTimeZone = await timeZoneFor("google_ads", clients, env);
      envelope.notes.push(timeZoneNote("Google Ads", envelope.reportingTimeZone));
      if (report.rowsRead === 0) {
        envelope.notes.push("Google Ads returned no rows for this range: the campaign delivered nothing in it. This is a real result, not a failed read.");
      }
    } else if (channel === "meta_ads") {
      const client = clients.metaAds || metaAds;
      const report = await client.campaignInsights({ providerCampaignId, startDate: range.startDate, endDate: range.endDate }, env);

      /* Meta reports spend in whole currency units as a string, not minor
         units — unlike its budgets, which are minor units. Carried through
         `money` with the unit named so the two cannot be confused. */
      const spend = report.spend === null ? null : {
        amount: report.spend,
        currency: str(report.currency).toUpperCase() || null,
        precision: "currency_units",
        providerAmount: String(report.spend),
        providerUnit: "currency_units",
      };
      const clicks = measured(report.clicks);

      envelope.metrics = {
        spend: spendMetric(spend),
        impressions: measured(report.impressions),
        /* Meta's one measurement Google has no equivalent for: people, not
           impressions. */
        reach: measured(report.reach),
        clicks,
        websiteVisits: unsupported("analytics_reported"),
        providerConversions: measured(report.conversions),
        leads: unavailable("grav_owned"),
        costPerClick: ratio(spendMetric(spend), clicks),
        costPerLead: unavailable("grav_derived"),
      };
      envelope.conversionBasis = "provider_definition";
      envelope.reportingTimeZone = await timeZoneFor("meta_ads", clients, env);
      envelope.notes.push(timeZoneNote("Meta Ads", envelope.reportingTimeZone));
      if (report.conversionActionTypes?.length) {
        /* The DEFINITION, published. Meta's `actions` array has dozens of types
           and GRAV counted a subset; a reader who disagrees can see which. */
        envelope.notes.push(`Conversions count these Meta action types: ${report.conversionActionTypes.join(", ")}.`);
      } else if (report.conversions === null) {
        envelope.notes.push("Meta reported no conversion actions for this campaign in this range.");
      }
      if (report.rowsRead === 0) {
        envelope.notes.push("Meta returned no rows for this range: the campaign delivered nothing in it. This is a real result, not a failed read.");
      }
    }
  } catch (err) {
    const state = directory.stateForFailure(err);
    envelope.readState = state === "ready" ? "unavailable" : state;
    envelope.reasonCode = str(err?.code) || null;
    /* Every metric stays `unavailable`. NOT zero, and the note says it
       explicitly, because this is the sentence that stops a screen from
       reporting a campaign as costing nothing. */
    envelope.metrics = blank(channel === "google_analytics" ? "analytics_reported" : "provider_reported");
    envelope.notes.push("Nothing was read. These figures are unknown, not zero, and this says nothing about whether the campaign is running or spending.");
  }

  return envelope;
}

/**
 * GA4 campaign and source performance, for an explicit property and range.
 *
 * ── NOT JOINED TO THE ADVERTISING CHANNELS ─────────────────────────────────
 * GA4 rows key on a campaign NAME a browser reported, and two campaigns in two
 * channels can share a name. Joining on it would attribute Meta's sessions to a
 * Google campaign, and the join would look right on every screen. So this is
 * served as its own report, labelled `analytics_reported`, and a caller that
 * wants to compare does so knowing what it is comparing.
 */
async function analyticsReport({
  companyId, startDate, endDate, limit = 100, env = process.env, client = null,
} = {}) {
  directory.assertCompanyMayRead(companyId, env);
  const range = assertRange({ startDate, endDate });
  const readAt = new Date().toISOString();

  const envelope = {
    channel: "google_analytics",
    channelLabel: channelSpec("google_analytics").label,
    dateRange: { startDate: range.startDate, endDate: range.endDate, days: range.days },
    readState: "ok",
    reasonCode: null,
    reportingTimeZone: null,
    rows: null,
    sampled: null,
    totalRows: null,
    measuredAt: readAt,
    conversionBasis: "analytics_definition",
    notes: [],
  };

  const ga = client || analytics;

  /* The property's timezone is read separately, and its absence does not cost
     the report: a figure without its timezone is still worth showing, labelled
     as having an unknown one. */
  try {
    const property = await ga.verifyProperty(env);
    envelope.reportingTimeZone = property.timeZone || null;
  } catch {
    envelope.reportingTimeZone = null;
    envelope.notes.push("GRAV could not read the property's reporting timezone, so the exact day boundaries of this range are unknown.");
  }

  try {
    const report = await ga.campaignReport({ startDate: range.startDate, endDate: range.endDate, limit }, env);
    envelope.rows = report.rows.map((r) => ({
      campaignName: r.campaignName,
      source: r.source,
      medium: r.medium,
      sessions: measured(r.sessions, "analytics_reported"),
      users: measured(r.users, "analytics_reported"),
      conversions: measured(r.conversions, "analytics_reported"),
    }));
    envelope.totalRows = report.totalRows;
    envelope.sampled = report.sampled;
    envelope.notes.push("Reported by website analytics, not by the advertising channels. These figures count browser sessions after consent and ad blocking, so they will not match a channel's own click count.");
    if (report.sampled) {
      envelope.notes.push("Analytics estimated these figures rather than counting them. Treat them as approximate.");
    }
  } catch (err) {
    const state = directory.stateForFailure(err);
    envelope.readState = state === "ready" ? "unavailable" : state;
    envelope.reasonCode = str(err?.code) || null;
    envelope.rows = null;
    envelope.notes.push("Nothing was read. These figures are unknown, not zero.");
  }

  return envelope;
}

const vocabulary = Object.freeze({
  metricStates: METRIC_STATES,
  metricSources: METRIC_SOURCES,
  conversionBasis: CONVERSION_BASIS,
  maxRangeDays: REPORT_MAX_DAYS,
  notClaimed: Object.freeze([
    "Revenue, opportunities and return on ad spend are not in this contract. No GRAV commercial outcome is connected to a campaign yet.",
    "Conversions are not comparable between channels and are never totalled across them.",
    "Analytics figures and channel figures measure different things and will not reconcile exactly.",
  ]),
});

module.exports = {
  read,
  analyticsReport,
  assertRange,
  ratio,
  measured,
  vocabulary,
};
