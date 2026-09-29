// services/marketing/performance/observationSync.service.js
//
// READING WHAT A CAMPAIGN ACTUALLY DID, AND WRITING IT DOWN HONESTLY.
//
// ── ONE DIRECTION ONLY ─────────────────────────────────────────────────────
// This service reads advertising accounts and writes GRAV records. It changes
// nothing in any channel, and it cannot: it imports the read clients and has no
// access to either write client. Every call it makes goes through
// `channelHttp.assertReadOnly`, which refuses any verb but GET.
//
// ── IT STARTS FROM A DEPLOYMENT, NOT FROM AN ACCOUNT ───────────────────────
// The entry point is a company-scoped GRAV deployment record: this plan, this
// approved revision, this channel, this external campaign. That ordering is the
// whole safety story. A service that started from "read the account's campaigns"
// would have to decide which of them belonged to which plan, and the only
// honest answer to that is the deployment record GRAV wrote when it created
// them.
//
// So it reads exactly one campaign — the one this deployment created — and it
// proves the bound account is still the account that campaign was created in
// before it publishes a single figure.
//
// ── AND MISSING IS NEVER ZERO ──────────────────────────────────────────────
// Every normalisation below returns `null` for a metric the channel did not
// report. A day the channel could not be asked about is `unavailable`, not a
// day of zeros. A day that is still being counted is `partial`. Those three
// states are the difference between a report somebody can act on and a report
// that quietly invents a bad month.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const googleAds = require("../channels/googleAdsClient");
const metaAds = require("../channels/metaAdsClient");
const binding = require("../deployment/accountBinding.service");
const { stableJson } = require("../campaignDrafts/campaignAllocation.service");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignObservation,
  MarketingCampaignObservationRevision,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const {
  MONEY,
  RANGE,
  PERFORMANCE_CODES: C,
} = require("../../../constants/marketingPerformance");

const str = (v) => String(v ?? "").trim();

/* A finite number, or null. Never a coercion: `Number("")` is 0, `Number(null)`
   is 0 and `Number(true)` is 1, and every one of those is a metric nobody
   reported rendered as a figure somebody will act on. */
const num = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
};

const assertCompany = (companyId) => {
  const raw = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("VALIDATION", "Campaign figures belong to a company.", { field: "companyId" });
  }
  return new mongoose.Types.ObjectId(raw);
};

/* ── CALENDAR DATES, AS STRINGS ─────────────────────────────────────────────
   An advertising day is a calendar day in the ACCOUNT's timezone. These never
   become Date objects on the way through, so a report cannot shift by a day
   because the server moved. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value, field) {
  const raw = str(value);
  if (!DATE_PATTERN.test(raw)) {
    throw fail("VALIDATION", "A date must be written as YYYY-MM-DD.", { field });
  }
  /* Round-tripped, so `2026-02-31` is refused rather than silently becoming a
     day in March — which would label a report February and fill it with
     another month's figures. */
  const [y, m, d] = raw.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw fail("VALIDATION", "That is not a real date.", { field });
  }
  return raw;
}

function assertRange({ startDate, endDate }) {
  const from = assertDate(startDate, "startDate");
  const to = assertDate(endDate, "endDate");
  if (from > to) {
    throw fail("VALIDATION", "The start of that range is after its end.", { field: "startDate", code: C.RANGE_INVALID });
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > RANGE.MAX_DAYS) {
    throw fail("VALIDATION",
      `That range covers ${days} days. GRAV reads at most ${RANGE.MAX_DAYS} at a time.`,
      { field: "endDate", code: C.RANGE_TOO_LONG });
  }
  return { from, to, days };
}

/* ── TODAY, IN THE ACCOUNT'S OWN TIMEZONE ───────────────────────────────────
   Which day is "today" decides which days are still being counted, and an
   account in Asia/Kolkata is most of a day ahead of one in America/New_York.
   Using the server's own date would mark a finished day partial — or, worse,
   mark an unfinished one complete and sum it into a month.

   `Intl` is in the Node runtime and needs no dependency. An unrecognised
   timezone falls back to UTC and is logged: a wrong-by-hours boundary is
   better than a crash, and being told about it is better than neither. */
function todayIn(timeZone) {
  const zone = str(timeZone) || "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch {
    console.warn(`[marketing-performance] unknown reporting timezone ${zone}; falling back to UTC`);
    return new Date().toISOString().slice(0, 10);
  }
}

/* ── HOW LONG A DAY KEEPS CHANGING ──────────────────────────────────────────
   Both channels revise a day after it ends: spend is reconciled and late
   conversions arrive through attribution windows. A figure read the morning
   after is not the figure the channel will settle on.

   Three days is the conservative reading of both platforms' documented
   attribution defaults. It is deliberately a GRAV decision rather than
   something inferred, and it is written down so it can be argued with. */
const SETTLING_DAYS = 3;

function completenessFor({ date, today }) {
  if (date > today) {
    /* A day that has not happened. Asked for by a range that runs into the
       future; there is nothing to read. */
    return { completeness: "unavailable", reason: "never_read" };
  }
  if (date === today) {
    return { completeness: "partial", reason: "day_not_finished" };
  }
  const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (ageDays <= SETTLING_DAYS) {
    return { completeness: "partial", reason: "attribution_window_open" };
  }
  return { completeness: "complete", reason: "" };
}

/* ── MONEY, CONVERTED ONCE ──────────────────────────────────────────────────
   Google reports micros — millionths of a currency unit. Meta reports a decimal
   string in major units. Both become micros here, which is lossless for Google
   and exact for Meta's two places, and the rounding to minor units happens once
   at the end rather than per day. A month of per-day rounding is a real
   discrepancy against the channel's own invoice. */
const microsFromMajor = (major) => (major === null ? null : Math.round(major * MONEY.MICROS_PER_MAJOR_UNIT));
const minorFromMicros = (micros) => (micros === null ? null : Math.round(micros / MONEY.MICROS_PER_MINOR_UNIT));

/* ── ONE CHANNEL'S DAY → GRAV'S DAY ─────────────────────────────────────────
   The two normalisers below are the only place either channel's vocabulary
   appears. Everything downstream — storage, totals, the API — speaks GRAV's.

   Each returns `null` for a metric its channel does not report, and that
   absence survives all the way to the response. */
const NORMALISERS = Object.freeze({
  google_ads: (day) => ({
    impressions: num(day.impressions),
    /* Google reports neither on a Search campaign. */
    reach: null,
    landingPageViews: null,
    clicks: num(day.clicks),
    spendMicros: num(day.costMicros),
    conversions: num(day.conversions),
    conversionValueMicros: microsFromMajor(num(day.conversionValue)),
    conversionBasis: {
      countedTypes: [],
      means: "Every conversion action configured in this advertising account.",
    },
  }),
  meta_ads: (day) => ({
    impressions: num(day.impressions),
    reach: num(day.reach),
    landingPageViews: num(day.landingPageViews),
    clicks: num(day.clicks),
    spendMicros: microsFromMajor(num(day.spend)),
    conversions: num(day.conversions),
    conversionValueMicros: microsFromMajor(num(day.conversionValue)),
    conversionBasis: {
      countedTypes: day.conversionActionTypes || [],
      means: "Outcome-shaped actions only — leads, purchases, registrations. Not every tracked action.",
    },
  }),
});

/* The facts, hashed. Comparing this is how "did anything change" is answered
   without comparing nine nullable fields by hand — and it is what makes a
   re-sync that read the same numbers a genuine no-op. */
function fingerprintOf(facts) {
  const basis = {
    impressions: facts.impressions,
    reach: facts.reach,
    clicks: facts.clicks,
    landingPageViews: facts.landingPageViews,
    spendMicros: facts.spendMicros,
    conversions: facts.conversions,
    conversionValueMicros: facts.conversionValueMicros,
    completeness: facts.completeness,
    currency: facts.currency,
  };
  return crypto.createHash("sha256").update(stableJson(basis)).digest("hex").slice(0, 32);
}

/**
 * The deployment this sync is about, and proof its account has not moved.
 *
 * ── THE CHECK THAT STOPS ONE ACCOUNT'S FIGURES BECOMING ANOTHER'S ──────────
 * A company can rebind to a different advertising account. The campaign this
 * deployment created still lives in the OLD one, and reading the new one for a
 * campaign id that means something else there would attach a stranger's figures
 * to this plan. Refused before anything is published.
 */
async function resolveDeployment({ companyId, deploymentId }) {
  const company = assertCompany(companyId);

  const deployment = await MarketingCampaignDeployment
    .findOne({ _id: deploymentId, companyId: company })
    /* The account this deployment's objects live in. `select: false` on the
       observation, and never published from here either. */
    .lean();

  if (!deployment) {
    throw fail("NOT_FOUND", "That campaign deployment could not be found.",
      { field: "deploymentId", code: C.DEPLOYMENT_NOT_FOUND });
  }

  const campaignObject = (deployment.externalObjects || []).find((o) => o.role === "campaign");
  if (!campaignObject?.providerObjectId) {
    /* A deployment with no campaign is one that failed before creating it, or
       one whose sequence never got that far. There is nothing to read. */
    throw fail("NOT_FOUND",
      "Nothing has been created in the advertising account for this deployment yet, so there are no figures to read.",
      { field: "deploymentId", code: C.NO_EXTERNAL_CAMPAIGN });
  }

  const bound = await binding.forDeployment({ companyId: company, channel: deployment.channel });

  return { company, deployment, bound, externalCampaignId: str(campaignObject.providerObjectId) };
}

/* ── READING THE CHANNEL ────────────────────────────────────────────────────
   One call, one campaign, a window. Returns the days it got and a reason if it
   got none — the reason is what turns "we could not look" into an honest
   `unavailable` rather than a silent gap. */
async function readChannel({ deployment, bound, externalCampaignId, from, to }, deps) {
  const channel = deployment.channel;

  try {
    if (channel === "google_ads") {
      const client = deps.googleAds || googleAds;
      const out = await client.campaignDailyReport({
        customerId: bound.externalAccountId,
        loginCustomerId: bound.loginAccountId,
        campaignId: externalCampaignId,
        startDate: from,
        endDate: to,
      });
      return { ok: true, currency: out.currency, days: out.days };
    }
    if (channel === "meta_ads") {
      const client = deps.metaAds || metaAds;
      const out = await client.campaignDailyInsights({
        campaignId: externalCampaignId,
        startDate: from,
        endDate: to,
      });
      return { ok: true, currency: out.currency, days: out.days };
    }
  } catch (err) {
    /* ── A REFUSAL AND AN OUTAGE ARE DIFFERENT FACTS ────────────────────────
       One means the connection may not read this account; the other means GRAV
       could not find out. Both leave the days unavailable, and a reader is told
       which. The provider's own message never travels — it went to the server
       log through `channelHttp`. */
    const code = str(err?.code);
    return {
      ok: false,
      reason: code === "CHANNEL_ACCESS_REFUSED" ? "channel_refused" : "channel_unavailable",
      days: [],
      currency: null,
    };
  }

  throw fail("CAMPAIGN_DEPLOYMENT_NOT_BUILT",
    "GRAV does not read campaign figures from that channel.",
    { field: "channel", code: C.CHANNEL_UNSUPPORTED });
}

/**
 * Read one deployment's figures for a window and write them down.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────
 * One row per (company, deployment, day), enforced by a unique index. A second
 * sync reading the same numbers finds the row, compares fingerprints and
 * changes nothing. A second sync reading DIFFERENT numbers — which happens
 * routinely as a channel reconciles spend — supersedes the row, increments its
 * revision and appends the old values to an append-only history.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {ObjectId} args.deploymentId
 * @param {string}   args.startDate  `YYYY-MM-DD`
 * @param {string}   args.endDate    `YYYY-MM-DD`
 */
async function sync({ companyId, deploymentId, startDate, endDate }, deps = {}) {
  const { from, to } = assertRange({ startDate, endDate });
  const { company, deployment, bound, externalCampaignId } = await resolveDeployment({ companyId, deploymentId });

  /* ── THE ACCOUNT HAS NOT MOVED ──────────────────────────────────────────
       Compared against the account this deployment's own observations were
       taken from, where any exist. A rebind produces figures from a different
       place, and attaching them to this plan would be attributing a stranger's
       spend to somebody's campaign. */
  const previous = await MarketingCampaignObservation
    .findOne({ companyId: company, deploymentId: deployment._id })
    .select("+externalAccountId")
    .sort({ reportingDate: -1 })
    .lean();

  if (previous && str(previous.externalAccountId) !== str(bound.externalAccountId)) {
    console.error(`[marketing-performance] deployment ${deployment._id} was bound to a different account since its last read`);
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "This campaign's figures were read from a different advertising account than the one bound to this company now. GRAV will not mix them. Somebody has to check which account this campaign lives in.",
      { field: "binding", code: C.ACCOUNT_CHANGED });
  }

  const timeZone = str(bound.timeZone) || "UTC";
  const today = todayIn(timeZone);
  const observedAt = new Date();

  const read = await readChannel({ deployment, bound, externalCampaignId, from, to }, deps);
  const byDate = new Map((read.days || []).map((d) => [str(d.date), d]));
  const normalise = NORMALISERS[deployment.channel];

  const written = [];
  let changed = 0;
  let unchanged = 0;

  for (const date of eachDate(from, to)) {
    const settled = completenessFor({ date, today });
    const day = byDate.get(date) || null;

    /* ── THREE CASES, AND ONLY ONE OF THEM HAS NUMBERS ────────────────────
       The read failed: unavailable, with the reason.
       The read succeeded and this day is absent: the channel is telling GRAV
         the campaign did nothing that day. Zeros are CORRECT here, because the
         channel answered — this is the one place a zero is honest.
       The read succeeded and returned the day: its figures, as reported. */
    let facts;
    if (!read.ok) {
      facts = {
        impressions: null, reach: null, clicks: null, landingPageViews: null,
        spendMicros: null, conversions: null, conversionValueMicros: null,
        conversionBasis: null,
        completeness: "unavailable",
        incompleteReason: read.reason,
        currency: previous?.currency || "",
      };
    } else if (!day) {
      facts = {
        impressions: 0, reach: null, clicks: 0, landingPageViews: null,
        spendMicros: 0, conversions: 0, conversionValueMicros: null,
        conversionBasis: null,
        completeness: settled.completeness,
        incompleteReason: settled.reason,
        currency: str(read.currency) || str(bound.currency) || "",
      };
      /* Reach and value stay null even here: a channel that reports no row is
         saying there was no activity, not that reach was zero — and Google
         never reports reach at all. */
    } else {
      facts = {
        ...normalise(day),
        completeness: settled.completeness,
        incompleteReason: settled.reason,
        currency: str(read.currency) || str(bound.currency) || "",
      };
    }

    const result = await upsertDay({
      company, deployment, bound, externalCampaignId,
      date, timeZone, facts, observedAt,
    });
    written.push(result.observation);
    if (result.changed) changed += 1; else unchanged += 1;
  }

  return {
    deploymentId: deployment._id,
    channel: deployment.channel,
    range: { startDate: from, endDate: to },
    daysWritten: written.length,
    daysChanged: changed,
    daysUnchanged: unchanged,
    read: read.ok ? "ok" : read.reason,
    observedAt,
  };
}

/* Every date in the window, inclusive, as strings. Arithmetic in UTC so a
   server's own timezone cannot shorten or lengthen the list. */
function* eachDate(from, to) {
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86400000;
  }
}

/**
 * Write one day, or leave it exactly as it was.
 *
 * ── THE SUPERSEDE IS CONDITIONAL, DELIBERATELY ─────────────────────────────
 * The update is fenced on the revision the caller read, so two syncs racing on
 * one day cannot both increment it and lose one of the revisions. The loser
 * finds the row already moved and leaves it: it read the same channel moments
 * earlier, so its figures are not better.
 */
async function upsertDay({ company, deployment, bound, externalCampaignId, date, timeZone, facts, observedAt }) {
  const fingerprint = fingerprintOf(facts);

  const existing = await MarketingCampaignObservation
    .findOne({ companyId: company, deploymentId: deployment._id, reportingDate: date });

  const values = {
    impressions: facts.impressions,
    reach: facts.reach,
    clicks: facts.clicks,
    landingPageViews: facts.landingPageViews,
    spendMicros: facts.spendMicros,
    spendMinorUnits: minorFromMicros(facts.spendMicros),
    conversions: facts.conversions,
    conversionValueMicros: facts.conversionValueMicros,
    conversionValueMinorUnits: minorFromMicros(facts.conversionValueMicros),
    conversionBasis: facts.conversionBasis,
    completeness: facts.completeness,
    incompleteReason: facts.incompleteReason || "",
    currency: facts.currency,
    reportingTimeZone: timeZone,
    observedAt,
    factsFingerprint: fingerprint,
  };

  if (!existing) {
    const created = await MarketingCampaignObservation.create({
      companyId: company,
      campaignDraftId: deployment.campaignDraftId,
      draftRef: deployment.draftRef,
      approvedRevision: deployment.approvedRevision,
      deploymentId: deployment._id,
      channel: deployment.channel,
      externalAccountId: bound.externalAccountId,
      externalCampaignId,
      reportingDate: date,
      metricRevision: 1,
      ...values,
    });
    return { observation: created.toObject(), changed: true };
  }

  /* ── NOTHING MOVED ──────────────────────────────────────────────────────
     The channel said the same thing. `observedAt` is NOT bumped: it records
     when the figures were established, and a reader judging freshness of a
     figure wants that rather than the last time anybody looked. Freshness of
     the READ is a separate fact the report service derives from the sync. */
  if (existing.factsFingerprint === fingerprint) {
    return { observation: existing.toObject(), changed: false };
  }

  /* ── THE CHANNEL CORRECTED ITSELF ─────────────────────────────────────── */
  await MarketingCampaignObservationRevision.create({
    companyId: company,
    observationId: existing._id,
    deploymentId: deployment._id,
    reportingDate: date,
    metricRevision: existing.metricRevision,
    factsFingerprint: existing.factsFingerprint,
    completeness: existing.completeness,
    observedAt: existing.observedAt,
    supersededAt: new Date(),
    impressions: existing.impressions,
    reach: existing.reach,
    clicks: existing.clicks,
    landingPageViews: existing.landingPageViews,
    spendMinorUnits: existing.spendMinorUnits,
    spendMicros: existing.spendMicros,
    conversions: existing.conversions,
    conversionValueMinorUnits: existing.conversionValueMinorUnits,
    conversionValueMicros: existing.conversionValueMicros,
  });

  const updated = await MarketingCampaignObservation.findOneAndUpdate(
    {
      _id: existing._id,
      companyId: company,
      /* Fenced on what was read. A racing sync that already moved this row
         leaves it moved. */
      metricRevision: existing.metricRevision,
    },
    { $set: { ...values, metricRevision: existing.metricRevision + 1 } },
    { new: true },
  ).lean();

  return { observation: updated || existing.toObject(), changed: Boolean(updated) };
}

/**
 * Sync every deployment of one campaign plan.
 *
 * A plan can be deployed to both channels. Each is read separately and stored
 * separately; nothing here combines them, because whether two channels' figures
 * can be added is a question the report service answers metric by metric.
 */
async function syncPlan({ companyId, campaignDraftId, startDate, endDate }, deps = {}) {
  const company = assertCompany(companyId);

  const deployments = await MarketingCampaignDeployment
    .find({ companyId: company, campaignDraftId })
    .sort({ channel: 1, approvedRevision: -1 })
    .lean();

  if (!deployments.length) {
    return { synced: [], means: "Nothing has been created in any advertising account for this plan, so there are no figures to read." };
  }

  const synced = [];
  for (const deployment of deployments) {
    try {
      synced.push(await sync({
        companyId: company, deploymentId: deployment._id, startDate, endDate,
      }, deps));
    } catch (err) {
      /* One channel failing must not stop the other being read. The failure is
         reported in GRAV's own code, and that deployment's days are left as
         they were — a failed read never overwrites a figure that was true. */
      synced.push({
        deploymentId: deployment._id,
        channel: deployment.channel,
        read: "failed",
        reasonCode: str(err?.code) || "CHANNEL_UNAVAILABLE",
      });
    }
  }

  return { synced };
}

module.exports = {
  sync,
  syncPlan,
  /* Exported for the suites that prove normalisation and completeness without
     a channel or a database. None of them can write anywhere. */
  __internals: {
    NORMALISERS, completenessFor, fingerprintOf, todayIn, eachDate,
    microsFromMajor, minorFromMicros, assertRange, SETTLING_DAYS,
  },
};
