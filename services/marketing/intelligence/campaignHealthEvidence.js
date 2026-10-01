// services/marketing/intelligence/campaignHealthEvidence.js
//
// WHAT ACTUALLY CHANGED, CALCULATED BY GRAV, BEFORE ANY MODEL IS INVOLVED.
//
// ── PURE ───────────────────────────────────────────────────────────────────
// No network, no database, no clock, no randomness, no environment. It takes a
// performance report GRAV already assembled and returns facts. The same report
// produces the same evidence for ever, which is what lets an analysis be reused
// rather than regenerated — and what lets this be tested exhaustively without a
// model, an advertising account or a database.
//
// ── GRAV CALCULATES. THE MODEL EXPLAINS. ───────────────────────────────────
// Every percentage change, every ratio and every threshold decision happens
// here. A language model asked to compute a change will produce one that looks
// right and is sometimes wrong, and nobody checks a plausible number.
//
// ── AND IT PRODUCES NO RECOMMENDATION ──────────────────────────────────────
// Not one. It says "clicks fell 23% between these dates, on these denominators"
// and stops. What that means, and what somebody might do about it, is the part
// a model is actually good at — and the part GRAV can check afterwards because
// every sentence has to cite one of these ids.
//
// ── THE REFUSALS MATTER MORE THAN THE CALCULATIONS ─────────────────────────
// Insufficient coverage produces no evidence at all, which means no model call.
// An explanation of two days of noise is still an explanation somebody acts on,
// and it costs tokens to produce something actively misleading.
"use strict";

const crypto = require("crypto");

const {
  COVERAGE,
  CHANGE_THRESHOLDS,
  METRIC_DIRECTION,
  WINDOW,
} = require("../../../constants/marketingCampaignHealth");

const str = (v) => String(v ?? "").trim();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ── A STABLE SERIALISER ────────────────────────────────────────────────────
   Keys sorted at every depth, so two structurally identical packets produce the
   same fingerprint whatever order they were built in. Without this, "has the
   evidence changed" would answer yes every time a field moved. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/* ── SUMMING A PERIOD ───────────────────────────────────────────────────────
   `complete` days only, and `null` plus anything is still the running value —
   so a total stays null until at least one real figure lands in it. A total of
   0 means the channels reported zero; a total of null means nobody reported.

   Reach is deliberately absent from every sum. The same person reached on two
   days is one person and no daily row says which; adding them invents an
   audience, and an adviser explaining an invented audience is worse than one
   that says nothing about reach. */
function sumPeriod(days) {
  const settled = days.filter((d) => d.completeness === "complete");

  const add = (running, value) => (value === null || value === undefined
    ? running
    : (running === null ? 0 : running) + value);

  const totals = {
    impressions: null,
    clicks: null,
    conversions: null,
    spendMinorUnits: null,
    landingPageViews: null,
  };

  for (const d of settled) {
    totals.impressions = add(totals.impressions, d.impressions);
    totals.clicks = add(totals.clicks, d.clicks);
    totals.conversions = add(totals.conversions, d.conversions);
    totals.spendMinorUnits = add(totals.spendMinorUnits, d.spendMinorUnits);
    totals.landingPageViews = add(totals.landingPageViews, d.landingPageViews);
  }

  /* ── RATIOS, WITH THE SAME RULE THE REPORT USES ──────────────────────────
     Both inputs known and the denominator above zero, or the ratio does not
     exist. A campaign with no impressions has no click-through rate — not a
     rate of zero — and an adviser told "CTR 0%" writes a paragraph about
     creative fatigue for a campaign that never ran. */
  const ratio = (numerator, denominator) => {
    if (!isNum(numerator) || !isNum(denominator) || denominator <= 0) return null;
    return numerator / denominator;
  };

  totals.ctr = ratio(totals.clicks, totals.impressions);
  totals.cpc = ratio(totals.spendMinorUnits, totals.clicks);
  totals.cpa = ratio(totals.spendMinorUnits, totals.conversions);

  return {
    totals,
    settledDays: settled.length,
    firstDate: settled.length ? settled[0].date : null,
    lastDate: settled.length ? settled[settled.length - 1].date : null,
  };
}

/* ── ONE MEASURE'S MOVEMENT, WITH ITS WORKING SHOWN ─────────────────────────
   Every field a reader would need to check the arithmetic by hand: both values,
   both date ranges, both denominators where the measure is a ratio. An evidence
   item that said "clicks fell 23%" and nothing else is a number somebody has to
   trust.

   The two thresholds together are what stop noise being reported as a finding:
   two clicks becoming three is a 50% rise and means nothing, so a movement must
   clear a relative floor AND a per-metric absolute one. */
function movementFor({ metric, recent, previous, id }) {
  const a = previous.totals[metric];
  const b = recent.totals[metric];

  const base = {
    id,
    metric,
    direction: METRIC_DIRECTION[metric] || "neutral",
    recent: { value: b, from: recent.firstDate, to: recent.lastDate, settledDays: recent.settledDays },
    previous: { value: a, from: previous.firstDate, to: previous.lastDate, settledDays: previous.settledDays },
  };

  /* ── UNAVAILABLE IS NOT ZERO, AND IT IS NOT A DECLINE ──────────────────
     A metric nobody reported in one period cannot be compared. Reporting it as
     a fall to zero is the single most damaging thing this file could do: it
     would have the adviser explain a collapse that did not happen. */
  if (!isNum(a) || !isNum(b)) {
    return {
      ...base,
      kind: "insufficient",
      change: null,
      changePercent: null,
      why: !isNum(a) && !isNum(b)
        ? "Neither period has this measure, so there is nothing to compare."
        : "One of the two periods does not have this measure, so a comparison would be misleading.",
    };
  }

  const absolute = b - a;
  /* A previous value of zero has no percentage change — dividing by it is
     infinity, and "up ∞%" is not something to put in front of a marketer. The
     absolute movement is still reported. */
  const relative = a === 0 ? null : absolute / a;

  const floor = CHANGE_THRESHOLDS.ABSOLUTE_FLOOR[metric];
  const clearsAbsolute = floor === undefined || Math.abs(absolute) >= floor;
  const clearsRelative = relative !== null && Math.abs(relative) >= CHANGE_THRESHOLDS.RELATIVE;

  if (!clearsRelative || !clearsAbsolute) {
    return {
      ...base,
      kind: "stable",
      change: absolute,
      changePercent: relative,
      why: relative === null
        ? "The earlier period was zero, so there is no percentage to compare."
        : "This did not move far enough to be worth calling a change.",
    };
  }

  const anomalous = Math.abs(relative) >= CHANGE_THRESHOLDS.ANOMALY_RELATIVE;
  const good = base.direction === "higher_is_better" ? absolute > 0
    : base.direction === "lower_is_better" ? absolute < 0
      : null;

  return {
    ...base,
    kind: anomalous ? "anomaly" : (good === null ? "stable" : good ? "improvement" : "decline"),
    change: absolute,
    changePercent: relative,
    why: anomalous
      ? "This moved far enough that something structural probably changed."
      : good === null
        ? "This moved, and whether that is good depends on what the campaign is for."
        : good
          ? "This moved in the direction the campaign wants."
          : "This moved against the campaign.",
  };
}

/**
 * Turn a performance report into comparable evidence, or refuse.
 *
 * @param {object} args
 * @param {object} args.report   the normalised performance response
 * @param {object} args.plan     `{ objective, approvedRevision, state, name }`
 * @returns {{sufficient:boolean, reason?:string, evidence:object[], packet:object|null, fingerprint:string}}
 */
function evaluate({ report, plan = {} }) {
  const deployments = report?.deployments || [];

  if (!deployments.length) {
    return insufficient("This plan has not been created in any advertising channel, so there is nothing to look at.", "no_deployment");
  }

  const perDeployment = [];

  for (const [index, deployment] of deployments.entries()) {
    const daily = deployment.daily || [];

    /* ── TWO COMPARABLE PERIODS OF SETTLED DAYS ────────────────────────────
       The most recent settled days, and the equally long block before them.
       Both are drawn from `complete` days only — a partial day in either would
       make the comparison an arithmetic exercise rather than a meaningful one,
       and the recent period is the one partial days land in. */
    const settled = daily.filter((d) => d.completeness === "complete");

    if (settled.length < COVERAGE.MIN_TOTAL_SETTLED_DAYS) {
      perDeployment.push({
        channel: deployment.channel,
        sufficient: false,
        settledDays: settled.length,
        needed: COVERAGE.MIN_TOTAL_SETTLED_DAYS,
        why: "There are not enough finished days yet to compare two periods.",
      });
      continue;
    }

    const size = Math.min(
      WINDOW.DAYS_PER_PERIOD,
      Math.floor(settled.length / COVERAGE.PERIODS),
    );
    const recentDays = settled.slice(-size);
    const previousDays = settled.slice(-(size * 2), -size);

    const recent = sumPeriod(recentDays);
    const previous = sumPeriod(previousDays);

    /* ── EACH DEPLOYMENT ON ITS OWN ────────────────────────────────────────
       Never combined. Two channels bill in different currencies and count
       conversions differently, and an evidence item that added them would be a
       number comparable to nothing — which the model would then explain. */
    const metrics = ["impressions", "clicks", "conversions", "spendMinorUnits", "ctr", "cpc", "cpa"];
    const evidence = metrics.map((metric, n) => movementFor({
      metric,
      recent,
      previous,
      /* Short, stable, and scoped to the deployment so two channels' evidence
         cannot collide. The model cites these; GRAV checks every citation. */
      id: `E${index + 1}-${n + 1}`,
    }));

    perDeployment.push({
      channel: deployment.channel,
      sufficient: true,
      currency: deployment.currency,
      /* Named so the model cannot quietly compare across channels: two figures
         counted under different definitions are not comparable, and saying so
         in the packet is cheaper than hoping. */
      conversionBasis: deployment.conversionBasis?.means || null,
      periods: {
        recent: { from: recent.firstDate, to: recent.lastDate, settledDays: recent.settledDays },
        previous: { from: previous.firstDate, to: previous.lastDate, settledDays: previous.settledDays },
      },
      evidence,
    });
  }

  const usable = perDeployment.filter((d) => d.sufficient);
  if (!usable.length) {
    return insufficient(
      "There are not enough finished days of figures yet to compare one period with another.",
      "insufficient_coverage",
      { perDeployment },
    );
  }

  /* ── THE PACKET ─────────────────────────────────────────────────────────
     What the model is sent. Facts and safe context only: an objective, a
     channel, a revision number, and the measured movements with their dates and
     denominators.

     Not sent: the campaign's name, its headline, its destination, any account
     or campaign identifier, any database id. The gateway scans for most of those
     before transport, but the right place to leave them out is here. */
  const packet = {
    campaign: {
      /* The objective is a GRAV enum, not free text, so it cannot carry an
         instruction. */
      objective: str(plan.objective) || null,
      approvedRevision: Number(plan.approvedRevision) || null,
      state: str(plan.state) || null,
    },
    analysisWindow: {
      note: "Only finished days are compared. Days still being counted are excluded.",
    },
    deployments: usable.map((d) => ({
      channel: d.channel,
      currency: d.currency,
      conversionBasis: d.conversionBasis,
      periods: d.periods,
      /* ── NAMED `evidenceId`, NOT `id` ────────────────────────────────────
         In a packet where a database id must never appear, a bare `id` is the
         one field name that cannot mean anything safe. The gateway's key scan
         refuses it on sight, which is correct — so the field says what it
         actually is: a reference to a figure GRAV calculated. */
      facts: d.evidence.map((e) => ({
        evidenceId: e.id,
        measure: e.metric,
        finding: e.kind,
        recentValue: e.recent.value,
        previousValue: e.previous.value,
        absoluteChange: e.change,
        percentChange: e.changePercent,
        betterWhen: e.direction,
        note: e.why,
      })),
    })),
    /* Stated in the packet as well as in the system prompt. */
    rules: [
      "Every number here was calculated by GRAV. Do not calculate anything.",
      "Cite the evidenceId of every fact you use.",
      "Do not say one thing caused another.",
      "Do not promise a result.",
      "Figures from different channels are not comparable and must not be added.",
    ],
  };

  const evidenceIds = usable.flatMap((d) => d.evidence.map((e) => e.id));

  return {
    sufficient: true,
    evidence: usable,
    evidenceIds,
    packet,
    /* ── WHAT MAKES AN ANALYSIS REUSABLE ──────────────────────────────────
       Over the packet alone. Identical evidence and an identical prompt version
       mean the model would be asked exactly the same question, and asking it
       again would spend tokens to get the same answer. */
    fingerprint: crypto.createHash("sha256").update(stableJson(packet)).digest("hex").slice(0, 32),
    freshness: report?.freshness || null,
  };
}

function insufficient(message, reason, extra = {}) {
  return {
    sufficient: false,
    reason,
    message,
    evidence: [],
    evidenceIds: [],
    packet: null,
    fingerprint: null,
    ...extra,
  };
}

module.exports = { evaluate, __internals: { sumPeriod, movementFor, stableJson } };
