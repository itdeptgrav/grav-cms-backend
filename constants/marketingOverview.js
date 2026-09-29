// constants/marketingOverview.js
//
// THE VOCABULARY OF THE MARKETING OVERVIEW.
//
// ── THIS FILE DEFINES NO BUSINESS RULES ────────────────────────────────────
// Every number in the overview is computed by a contract that already exists:
// `campaignReport.service.js` owns completeness, combinability, money and the
// derived ratios; `handoverReadModel.service.js` owns handover counts; the
// engagement vocabulary owns what counts as meaningful engagement. This file
// holds only what the OVERVIEW itself adds — its default range, the words it
// puts on a screen, and the closed list of observations it may publish.
//
// If a rule here starts to look like a calculation, it belongs in the service
// that owns it, not here.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── THE DEFAULT RANGE IS THE LAST 30 *COMPLETE* DAYS ───────────────────────
   Ending yesterday, not today. Today is always partial — an advertising
   channel has not finished counting it, and the performance contract already
   refuses to put a partial day in a total. A default range ending today would
   therefore open every dashboard on a period whose last day is guaranteed to
   be excluded, and a reader comparing "last 30 days" week to week would be
   comparing 29 settled days against 30.

   The existing report contract defaults its end date to today because it is
   asked about one campaign and shows the daily series; the overview is a
   summary, so it starts from settled ground. */
const RANGE = freeze({
  DEFAULT_DAYS: 30,
  /* Validation itself — format, ordering, maximum length — is delegated to the
     performance contract's own `assertRange`, so the two cannot disagree about
     what a valid range is. */
  ENDS_YESTERDAY: true,
  means: "The most recent 30 finished days. Today is left out because no advertising channel has finished counting it.",
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/* ── THE SHAPE OF EVERY PUBLISHED METRIC ────────────────────────────────────
   `{ available, value, unit, why }`. The same shape whether a figure is known,
   withheld because it cannot be combined, or absent because nothing was
   measured — so a screen renders one component and never has to decide what a
   bare `null` meant.

   `available: false` with `value: null` is the ONLY way an unknown figure is
   published. A measured zero is `available: true, value: 0`, and the two must
   never collapse into each other: "we spent nothing" and "we do not know what
   we spent" lead to opposite decisions. */
const METRIC_UNITS = freeze({
  COUNT: "count",
  MINOR_UNITS: "minor_units",
  RATIO: "ratio",
  DECIMAL: "decimal",
});

/* ── WHICH DEPLOYMENT STATES MEAN "THIS EXISTS IN A CHANNEL" ────────────────
   Only these two. A plan that is approved, preparing, partially created or
   failed has NOT been created as a usable campaign, and the overview must not
   count it as one.

   `partially_created` is the one that tempts: some objects exist. But a
   half-built campaign is not a campaign — it cannot deliver, it has no
   figures, and listing it as deployed would put a row on a dashboard that
   looks like it is running. It is surfaced separately, as something needing
   attention, never as a campaign.

   `activated` is here because a campaign that is spending is certainly
   confirmed. Nothing in this slice can put a deployment into that state. */
const CONFIRMED_DEPLOYMENT_STATES = freeze(["paused_confirmed", "activated"]);

/* What a reader is told a confirmed deployment is doing. GRAV's own words, and
   deliberately not the provider's. */
const DEPLOYMENT_STATUS = [
  pair("live", "Running", {
    means: "This campaign exists in the advertising channel and is able to deliver.",
    states: freeze(["activated"]),
  }),
  pair("paused", "Created, not running", {
    means: "This campaign exists in the advertising channel and is stopped. It cannot deliver and cannot spend.",
    states: freeze(["paused_confirmed"]),
  }),
];
const DEPLOYMENT_STATUS_BY_STATE = freeze(Object.fromEntries(
  DEPLOYMENT_STATUS.flatMap((s) => s.states.map((state) => [state, s])),
));

/* ── APPROVAL IS NOT DEPLOYMENT ─────────────────────────────────────────────
   Stated here because it is the single easiest thing for an overview to get
   wrong, and because the sentence already exists on the plan contract's
   `approved` state. An approved plan has had nothing created in any
   advertising channel, commits no budget and can spend no money. */
const APPROVED_NOT_DEPLOYED = freeze({
  code: "approved_not_deployed",
  label: "Approved, not yet created",
  means: "An administrator agreed to this plan. Nothing has been created in any advertising channel, no budget is committed and no money can be spent because of it.",
});

/* ── WHAT THE OVERVIEW MAY SAY ──────────────────────────────────────────────
   A closed list. Every item is reproducible from figures in the same response:
   given the response, a reader can check the claim. Nothing here is generated,
   inferred, predicted or phrased as advice — an item states a fact and points
   at the page where something can be done about it.

   `tone` is for presentation only and carries no judgement about the business:
   `positive` marks a fact worth noticing, `attention` a fact somebody is
   waiting on, `neutral` a limitation of the data itself. */
const ATTENTION_TONES = freeze(["positive", "attention", "neutral"]);

const ATTENTION = [
  pair("best_cost_per_conversion", "Lowest cost per conversion", {
    tone: "positive",
    means: "Among campaigns where cost per conversion could be worked out, this one's is the lowest.",
    destination: "campaign",
  }),
  pair("handovers_awaiting_review", "Prospects waiting for Sales", {
    tone: "attention",
    means: "These prospects were submitted to Sales and have not been decided on yet.",
    destination: "handovers",
  }),
  pair("handovers_returned_for_nurture", "Prospects returned for nurture", {
    tone: "attention",
    means: "Sales sent these back. They are Marketing's to work on again.",
    destination: "handovers",
  }),
  pair("handovers_blocked", "Prospects blocked before submission", {
    tone: "attention",
    means: "These could not be submitted to Sales. Each one has a recorded reason.",
    destination: "handovers",
  }),
  pair("no_performance_measured", "No campaign figures in this period", {
    tone: "neutral",
    means: "GRAV has no settled advertising figures for these dates. That is not the same as a period with no activity.",
    destination: "campaigns",
  }),
  pair("performance_partial", "Some days are missing", {
    tone: "neutral",
    means: "Totals cover only the days GRAV could read and that are finished. The rest are shown in the daily figures and left out.",
    destination: "campaigns",
  }),
  pair("spend_not_combinable", "Spend is not added up", {
    tone: "neutral",
    means: "Campaigns in this period bill in more than one currency, so there is no single spend figure to show.",
    destination: "campaigns",
  }),
  pair("no_campaigns_created", "No campaigns created yet", {
    tone: "neutral",
    means: "No plan has been created in an advertising channel, so there is nothing to measure.",
    destination: "campaigns",
  }),
  pair("approved_awaiting_creation", "Approved plans not yet created", {
    tone: "attention",
    means: "These plans are approved. Nothing exists in an advertising channel for them yet.",
    destination: "campaigns",
  }),
];
const ATTENTION_CODES = codes(ATTENTION);
const ATTENTION_BY_CODE = freeze(Object.fromEntries(ATTENTION.map((a) => [a.code, a])));

/* ── WHERE AN OBSERVATION POINTS ────────────────────────────────────────────
   A GRAV screen, never a route file or a database collection — and the
   ADDRESS THE FRONTEND ACTUALLY SERVES, spelled once, here.

   ── WHY THAT SENTENCE HAD TO BE WRITTEN DOWN ─────────────────────────────
   This table used to publish `/marketing/campaigns/:campaignPlanId` for a
   campaign. No such route exists: the frontend's campaign screen is the
   performance workspace at `/marketing/campaigns/plans/:campaignPlanId/
   performance`, which takes the very identifier this contract signs. Every
   link built from the published path therefore 404'd, and the client had
   already begun translating the path back into a real one by matching on
   `code` — which is the worst of both worlds: the contract stays wrong, the
   client carries a table of corrections, and the two drift the first time
   either changes.

   So `path` is the canonical, complete address a client may use unaltered.
   A destination whose path a client has to fix is a destination this file
   has got wrong, and `marketing-overview.route.test.js` pins each one
   against the route the frontend serves.

   ── AND THE PARAMETER IS NAMED THE WAY THE RESPONSE NAMES IT ─────────────
   `:campaignPlanId` is substituted with the `campaignPlanId` a row or an
   evidence block already carries, so a client needs no mapping to know what
   to put where. */
const DESTINATION_PARAM = ":campaignPlanId";

const DESTINATIONS = freeze({
  campaigns: freeze({
    code: "campaigns",
    label: "Campaigns",
    path: "/marketing/campaigns",
    templated: false,
  }),
  campaign: freeze({
    code: "campaign",
    label: "Campaign",
    /* The performance workspace. It is the only per-campaign screen GRAV
       serves, and the identifier below is the one this contract signs. */
    path: `/marketing/campaigns/plans/${DESTINATION_PARAM}/performance`,
    templated: true,
    param: DESTINATION_PARAM,
  }),
  handovers: freeze({
    code: "handovers",
    label: "Handovers",
    path: "/marketing/handovers",
    templated: false,
  }),
});

const DESTINATION_CODES = codes(Object.values(DESTINATIONS));

/**
 * A destination a client can use unaltered.
 *
 * ── `path` IS ALWAYS READY ────────────────────────────────────────────────
 * A templated destination is resolved here, against the identifier the same
 * response already carries, so no client ever substitutes anything or keeps a
 * table mapping a code onto a real address. `template` travels beside it for
 * anybody who wants to see the shape, and for a destination with no parameter
 * the two are identical.
 *
 * ── AND A TEMPLATE IS NEVER PUBLISHED AS A PATH ───────────────────────────
 * Asking for a templated destination without its identifier is a programming
 * error here, not something to paper over: a `path` still containing
 * `:campaignPlanId` is a link that 404s, and publishing one is exactly the
 * fault this function was written to end.
 *
 * @param {string} code             one of DESTINATION_CODES
 * @param {object} [params]
 * @param {string} [params.campaignPlanId] the signed plan identifier
 */
function destinationFor(code, { campaignPlanId } = {}) {
  const spec = DESTINATIONS[code];
  if (!spec) throw new Error(`Unknown marketing destination: ${code}`);
  if (!spec.templated) {
    return freeze({ code: spec.code, label: spec.label, path: spec.path, template: spec.path });
  }

  const id = String(campaignPlanId ?? "").trim();
  if (!id) {
    throw new Error(`The ${code} destination needs a campaignPlanId to be a usable address.`);
  }
  return freeze({
    code: spec.code,
    label: spec.label,
    path: spec.path.replace(spec.param, encodeURIComponent(id)),
    template: spec.path,
  });
}

/* ── WHAT THE FRONTEND NEEDS TO KNOW ABOUT MISSING DATA ─────────────────────
   Three independent sources, each either available or not, plus one flag for
   "some of what you are reading is incomplete".

   Deliberately business-shaped. A screen must be able to say "no campaign
   figures yet" without being told about a queue, a retry, a connection or a
   provider — none of which a marketer can act on, and all of which invite a
   support ticket about something that is working. */
const AVAILABILITY_SOURCES = [
  pair("campaignPerformance", "Campaign figures", {
    whenAvailable: "GRAV has advertising figures for these dates.",
    whenUnavailable: "GRAV has no advertising figures for these dates yet.",
  }),
  pair("engagement", "Engagement", {
    whenAvailable: "GRAV has recorded people engaging in these dates.",
    whenUnavailable: "GRAV has recorded no engagement in these dates.",
  }),
  pair("handovers", "Handovers", {
    whenAvailable: "GRAV has handover records for this company.",
    whenUnavailable: "No prospect has been handed to Sales yet.",
  }),
];
const AVAILABILITY_SOURCE_CODES = codes(AVAILABILITY_SOURCES);

module.exports = freeze({
  RANGE,
  DATE_PATTERN,
  METRIC_UNITS,

  CONFIRMED_DEPLOYMENT_STATES,
  DEPLOYMENT_STATUS,
  DEPLOYMENT_STATUS_BY_STATE,
  APPROVED_NOT_DEPLOYED,

  ATTENTION,
  ATTENTION_CODES,
  ATTENTION_BY_CODE,
  ATTENTION_TONES,
  DESTINATIONS,
  DESTINATION_CODES,
  DESTINATION_PARAM,
  destinationFor,

  AVAILABILITY_SOURCES,
  AVAILABILITY_SOURCE_CODES,
});
