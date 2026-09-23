// constants/marketingDeploymentReadiness.js
//
// THE FIRST SUPPORTED ADVERTISING CAMPAIGN TYPES, AND WHAT READINESS MEANS.
//
// ── A DELIBERATELY NARROW MVP ──────────────────────────────────────────────
// Two campaign types, one per advertising channel. Everything else is
// UNSUPPORTED — named as such, never approximately mapped onto one of these.
//
// The reason to be this narrow is that a near-miss mapping is worse than a
// refusal. Performance Max and a Search campaign take different required objects;
// a Meta lead-form campaign needs a form GRAV does not model. Accepting one and
// quietly deploying it as the other produces a campaign in somebody's advertising
// account that does not do what the plan said, and nobody finds out from a GRAV
// screen.
//
// ── NOTHING HERE NAMES THE INTERNAL EMAIL ENGINE ───────────────────────────
// `email` is a channel a marketer selects. What sends it is not named, and the
// channel has no advertising campaign type at all — it is not a publisher of
// advertisements, so "unsupported campaign type" is the wrong frame for it.
"use strict";

const pair = (code, label, extra = {}) => Object.freeze({ code, label, ...extra });
const codes = (list) => Object.freeze(list.map((x) => x.code));

/* ── THE EVALUATOR VERSION ───────────────────────────────────────────────────
   Published with every result. A readiness answer is a judgement made by a
   particular set of rules, and a client holding yesterday's answer needs to be
   able to tell that today's rules are different — otherwise a plan that "passed"
   under v1 looks like it still passes after v2 tightened a check.

   Bumped whenever a rule is added, removed or changed in a way that could alter a
   verdict. Not bumped for wording. */
/* 1.1.0: the submission gate. Name, objective and conversion goal are judged for
   every plan, so readiness can no longer call a plan ready that Submit refuses. */
const EVALUATOR_VERSION = "readiness-1.1.0";

/* ── THE SUPPORTED CAMPAIGN TYPES ────────────────────────────────────────────
   One per advertising channel, and each entry says what GRAV can honestly prepare
   for it. `requires` is the list of brief sections the evaluator insists on, so
   adding a campaign type later means describing it here rather than editing the
   evaluator's branches.

   ── WHY THESE TWO, AND WHAT THE EXISTING CONTRACTS SUPPORT ────────────────
   GRAV's Google Ads adapter reads `campaign.advertising_channel_type`, so a Search
   campaign is the one type GRAV can already recognise when it reads an account
   back. Meta's adapter reads `objective`, and `OUTCOME_TRAFFIC` is the objective
   whose required child objects GRAV can fully describe from a plan: one ad set, one
   single-image ad, one destination URL.

   The honest gap, recorded rather than papered over: GRAV's content library holds
   emails, forms and landing pages. It holds no advertising IMAGE asset, so a Meta
   single-image campaign needs its image identified by a content reference whose
   kind the library does not yet have. The evaluator therefore treats the image as
   an external check — `media_asset_usable` — and refuses to call a Meta brief
   locally complete on the strength of a reference it cannot resolve. A later chunk
   that adds an advertising-media kind to the library turns that into a local check. */
const SUPPORTED_CAMPAIGN_TYPES = [
  pair("google_search", "Search campaign", {
    channel: "google_ads",
    /* What a marketer would call it, and what the channel calls it. Both, because
       a marketer reconciles GRAV against the advertising interface. */
    channelTerm: "Search",
    means: "Text advertisements on search results, sending people to a GRAV page.",
    requires: Object.freeze([
      "destination", "geoTargeting", "languages", "exclusions",
      "bidding", "creative", "conversionGoal", "tracking", "schedule",
    ]),
  }),
  pair("meta_traffic_single_image", "Website traffic, single image", {
    channel: "meta_ads",
    channelTerm: "Traffic",
    means: "One image advertisement sending people to a GRAV page.",
    requires: Object.freeze([
      "destination", "geoTargeting", "languages", "exclusions",
      "bidding", "creative", "media", "conversionGoal", "tracking", "schedule",
    ]),
  }),
];

/* ── CREATED ONLY UNDER CONTROL ──────────────────────────────────────────────
   A campaign type GRAV can plan, approve and CREATE — stopped — but only into an
   advertising account an administrator has named as the controlled proof
   account. It is not deployable: the capability matrix does not offer it, and
   `SUPPORTED_CAMPAIGN_TYPES` (which IS the deployable list, pinned by a test
   against the matrix) does not contain it.

   It exists so the proof a type needs before it can be offered — a real
   creation in a controlled account, and a real lead delivered end to end — can
   be carried out with every safety boundary the deployable types have, instead
   of by hand outside GRAV where nothing records it. */
const CONTROLLED_CAMPAIGN_TYPES = [
  /* Named exactly as the capability matrix names it — one type, one name. */
  pair("google_lead_form", "Lead form", {
    channel: "google_ads",
    channelTerm: "Lead form asset",
    /* A lead-form brief IS the Search brief plus the form: the builder takes
       its settings column from this type, stated rather than inferred. */
    settingsFrom: "google_search",
    /* Google serves a lead form only under conversion-focused bidding, and
       this is GRAV's one such strategy. */
    requiredBiddingStrategy: "target_cost_per_action",
    means: "Text advertisements on search results with a Google-hosted enquiry form, delivered to GRAV.",
    requires: Object.freeze([
      "destination", "geoTargeting", "languages", "exclusions",
      "bidding", "creative", "conversionGoal", "tracking", "schedule", "leadForm",
    ]),
    controlled: true,
    controlledMeans: "GRAV creates this campaign type, stopped, only in the advertising account an administrator has named for proving it. It is not offered for general use until a creation there and a real enquiry delivered from it have both been confirmed.",
  }),
];

/* Every type a deployment record or attempt may name: the deployable ones, and
   the ones created only under control. Readiness judges both; the capability
   matrix offers only the first. */
const RECORDABLE_CAMPAIGN_TYPES = Object.freeze([...SUPPORTED_CAMPAIGN_TYPES, ...CONTROLLED_CAMPAIGN_TYPES]);

/* What each advertising channel supports, and — stated explicitly — what it does
   not. A channel absent from this map publishes no advertisements. */
const CHANNEL_SUPPORT = Object.freeze({
  google_ads: Object.freeze({
    supported: Object.freeze(["google_search"]),
    /* Plannable and creatable ONLY into the controlled proof account. */
    controlled: Object.freeze(["google_lead_form"]),
    /* Named so a refusal can say what was asked for rather than only that it was
       refused. Not an exhaustive list of everything Google offers — an exhaustive
       list would be a maintenance burden and would still miss tomorrow's type. */
    knownUnsupported: Object.freeze([
      "google_performance_max", "google_display", "google_demand_gen",
      "google_shopping", "google_video", "google_app",
    ]),
  }),
  meta_ads: Object.freeze({
    supported: Object.freeze(["meta_traffic_single_image"]),
    knownUnsupported: Object.freeze([
      "meta_lead_form", "meta_carousel", "meta_video", "meta_catalogue",
      "meta_awareness", "meta_engagement",
    ]),
  }),
});

/* ── BIDDING ─────────────────────────────────────────────────────────────────
   GRAV's own words, mapped at deployment time. Deliberately few: each one GRAV
   offers is one it can describe completely, and a strategy that needs a target
   value needs that value in the plan.

   `maximise_clicks` is the starting default nobody has to configure, and it is
   still an explicit choice rather than a silent fallback — a plan with no bidding
   strategy is blocked, because the provider's own default decides how money is
   spent and "whatever the channel does" is not a decision somebody made. */
const BIDDING_STRATEGIES = [
  pair("maximise_clicks", "Maximise clicks", {
    means: "Spend the budget to get as many visits as possible.",
    needsTarget: false,
  }),
  pair("target_cost_per_click", "Target cost per click", {
    means: "Aim for an average cost per visit.",
    needsTarget: true,
    targetLabel: "Target cost per click",
  }),
  pair("target_cost_per_action", "Target cost per action", {
    means: "Aim for an average cost per conversion. Needs conversion tracking the channel can see.",
    needsTarget: true,
    targetLabel: "Target cost per action",
  }),
];

/* ── HOW THE BUDGET RELATES TO THE CAMPAIGN ──────────────────────────────────
   The plan already records an amount, a currency and a basis of total or daily.
   This says what that figure governs once deployed, which the two channels model
   differently: Google attaches a budget to a campaign, Meta may attach it to the
   campaign or to the ad set. A plan that does not say which is a plan that cannot
   be mapped without a guess. */
const BUDGET_RELATIONSHIPS = [
  pair("campaign_total", "One budget for the whole campaign", {
    means: "The amount is the campaign's entire spend across its schedule.",
  }),
  pair("campaign_daily", "A daily budget for the campaign", {
    means: "The amount is spent per day, for as long as the campaign runs.",
  }),
  pair("ad_set_daily", "A daily budget per audience", {
    means: "The amount is spent per day on each audience. Meta only.",
    channels: Object.freeze(["meta_ads"]),
  }),
];

/* ── WHERE A CLICK GOES ──────────────────────────────────────────────────────
   A GRAV page or a content-library landing page. NOT a provider lead form: GRAV
   does not model one, and accepting a plan that said "lead form" would mean
   deploying a campaign whose lead capture does not exist. */
const DESTINATION_KINDS = [
  pair("grav_landing_page", "A landing page in the content library", {
    means: "Identified by a content reference, so GRAV knows which page it is.",
    needsContentRef: true,
  }),
  pair("grav_site_url", "A page on the company website", {
    means: "A URL on the site recorded in the tracking configuration.",
    needsContentRef: false,
  }),
];

/* ── WHETHER SOMEBODY DECIDED ABOUT EXCLUSIONS ───────────────────────────────
   Three states, and the third is why this exists. "No exclusions" and "nobody has
   thought about exclusions" are different, and only the second should block.

   Uniform advertising beside content a company would not sponsor is a real
   commercial risk, and the way it happens is nobody making a decision. So a plan
   must say which of these it is. */
const EXCLUSION_DECISIONS = [
  pair("none_required", "Decided: no exclusions needed", {
    means: "Somebody considered exclusions and recorded that none apply.",
    decided: true,
  }),
  pair("listed", "Exclusions listed", {
    means: "Specific placements, audiences or terms are excluded.",
    decided: true,
  }),
  pair("not_decided", "Not decided yet", {
    means: "Nobody has recorded a decision about exclusions.",
    decided: false,
  }),
];

/* ── A FINDING'S SEVERITY ────────────────────────────────────────────────────
   Two, and no more. A third would immediately be argued about and would let a real
   blocker be filed as a middle category. */
const FINDING_SEVERITIES = [
  pair("blocking", "Must be fixed", { means: "This prevents the plan from being ready." }),
  pair("advisory", "Worth looking at", { means: "This does not prevent readiness." }),
];

/* ── WHAT A FINDING IS ABOUT ─────────────────────────────────────────────────
   Grouped so a response can be read as four answers to four different questions
   rather than one list a reader has to sort. */
const FINDING_GROUPS = [
  pair("missing_from_plan", "Missing from the plan", {
    means: "Information GRAV needs and the plan does not have.",
  }),
  pair("unsupported_by_grav", "Not supported by GRAV yet", {
    means: "A choice GRAV cannot prepare. It will not be approximated.",
  }),
  pair("contradiction", "Contradicts something else in the plan", {
    means: "Two parts of the plan cannot both be true.",
  }),
  pair("external_check_required", "Needs checking outside GRAV", {
    means: "Something only the channel or the content library can confirm, and nothing has asked it yet.",
  }),
  /* ── NOT THE SAME AS "GRAV CANNOT DO THIS" ──────────────────────────────
     A channel that carries no advertisements — email, or a measurement source — is
     not an unsupported choice. Filing it under `unsupported_by_grav` made an
     email-only plan's readiness report a non-empty "not supported" section, which
     reads as a problem with the plan. It is information about the channel. */
  pair("not_applicable", "Not part of advertising deployment", {
    means: "This channel carries no advertisements, so advertising readiness does not apply to it.",
  }),
];

/* ── THE STABLE FINDING CODES ────────────────────────────────────────────────
   GRAV-owned and additive. A client may branch on these; renaming one is a
   breaking change. No provider error text appears in any of them. */
const FINDING_CODES = Object.freeze({
  CHANNEL_NOT_A_PUBLISHER: "CHANNEL_NOT_A_PUBLISHER",
  CAMPAIGN_TYPE_MISSING: "CAMPAIGN_TYPE_MISSING",
  CAMPAIGN_TYPE_UNSUPPORTED: "CAMPAIGN_TYPE_UNSUPPORTED",
  CAMPAIGN_TYPE_WRONG_CHANNEL: "CAMPAIGN_TYPE_WRONG_CHANNEL",
  DESTINATION_MISSING: "DESTINATION_MISSING",
  DESTINATION_CONTENT_MISSING: "DESTINATION_CONTENT_MISSING",
  GEO_TARGETING_MISSING: "GEO_TARGETING_MISSING",
  LANGUAGES_MISSING: "LANGUAGES_MISSING",
  EXCLUSION_DECISION_MISSING: "EXCLUSION_DECISION_MISSING",
  BIDDING_MISSING: "BIDDING_MISSING",
  BIDDING_TARGET_MISSING: "BIDDING_TARGET_MISSING",
  BIDDING_NEEDS_CONVERSION_GOAL: "BIDDING_NEEDS_CONVERSION_GOAL",
  CREATIVE_INCOMPLETE: "CREATIVE_INCOMPLETE",
  MEDIA_REFERENCE_MISSING: "MEDIA_REFERENCE_MISSING",
  CONVERSION_GOAL_MISSING: "CONVERSION_GOAL_MISSING",
  CONVERSION_GOAL_INCOMPATIBLE: "CONVERSION_GOAL_INCOMPATIBLE",
  BUDGET_MISSING: "BUDGET_MISSING",
  BUDGET_CURRENCY_MISSING: "BUDGET_CURRENCY_MISSING",
  BUDGET_BASIS_MISSING: "BUDGET_BASIS_MISSING",
  BUDGET_RELATIONSHIP_MISSING: "BUDGET_RELATIONSHIP_MISSING",
  BUDGET_RELATIONSHIP_WRONG_CHANNEL: "BUDGET_RELATIONSHIP_WRONG_CHANNEL",
  BUDGET_BASIS_CONTRADICTS_RELATIONSHIP: "BUDGET_BASIS_CONTRADICTS_RELATIONSHIP",
  SCHEDULE_INCOMPLETE: "SCHEDULE_INCOMPLETE",
  SCHEDULE_REVERSED: "SCHEDULE_REVERSED",
  SCHEDULE_TIMEZONE_MISSING: "SCHEDULE_TIMEZONE_MISSING",
  TRACKING_IDENTITY_MISSING: "TRACKING_IDENTITY_MISSING",
  BRIEF_MISSING: "BRIEF_MISSING",
  PLAN_NAME_MISSING: "PLAN_NAME_MISSING",
  LEAD_FORM_INCOMPLETE: "LEAD_FORM_INCOMPLETE",
  LEAD_FORM_CONTROLLED_ONLY: "LEAD_FORM_CONTROLLED_ONLY",
  OBJECTIVE_MISSING: "OBJECTIVE_MISSING",
  PLAN_NOT_APPROVED: "PLAN_NOT_APPROVED",
  PLAN_TERMINAL: "PLAN_TERMINAL",
  /* External. Each names the authority that would have to answer it. */
  EXTERNAL_ACCOUNT_ACCESS: "EXTERNAL_ACCOUNT_ACCESS",
  EXTERNAL_ACCOUNT_CURRENCY: "EXTERNAL_ACCOUNT_CURRENCY",
  EXTERNAL_CONTENT_USABLE: "EXTERNAL_CONTENT_USABLE",
  EXTERNAL_MEDIA_USABLE: "EXTERNAL_MEDIA_USABLE",
  EXTERNAL_POLICY_COMPATIBLE: "EXTERNAL_POLICY_COMPATIBLE",
  EXTERNAL_MAPPED_OBJECT_VALID: "EXTERNAL_MAPPED_OBJECT_VALID",
  EXTERNAL_PAUSED_CREATION_POSSIBLE: "EXTERNAL_PAUSED_CREATION_POSSIBLE",
});

/* ── WHICH GOALS EACH SUPPORTED TYPE CAN HONESTLY PURSUE ──────────────────────
   A Search campaign sending people to a page can pursue a page view, a form
   submission, or GRAV's own qualified-prospect outcome. It cannot pursue a
   channel-reported conversion GRAV has not defined a mapping for, and saying it
   could would mean reporting a number nobody can reconcile.

   `sales_handover` is absent from both on purpose: nothing connects a campaign to
   an accepted handover yet, so a campaign optimised for one would be optimising
   for a number that does not exist. */
const GOAL_COMPATIBILITY = Object.freeze({
  google_search: Object.freeze(["page_view", "form_submission", "qualified_prospect"]),
  meta_traffic_single_image: Object.freeze(["page_view", "form_submission"]),
  /* A lead form produces a form submission; GRAV's own qualified-prospect
     outcome follows from one. A page view is not what a lead form is for. */
  google_lead_form: Object.freeze(["form_submission", "qualified_prospect"]),
});

/* ── BOUNDS ──────────────────────────────────────────────────────────────────
   Refused rather than trimmed, like everywhere else in this domain. */
const BRIEF_LIMITS = Object.freeze({
  HEADLINE_MAX: 120,
  BODY_MAX: 2000,
  CALL_TO_ACTION_MAX: 60,
  DESTINATION_URL_MAX: 2000,
  GEO_MAX: 50,
  GEO_NAME_MAX: 120,
  LANGUAGE_MAX: 10,
  AUDIENCE_MAX: 20,
  AUDIENCE_NAME_MAX: 120,
  EXCLUSION_MAX: 50,
  TIMEZONE_MAX: 64,
  /* Google Search takes several headlines; Meta's single-image takes one primary
     text and one headline. The minimum is what the channel will not create
     without. */
  GOOGLE_HEADLINES_MIN: 3,
  GOOGLE_DESCRIPTIONS_MIN: 2,
});

module.exports = {
  EVALUATOR_VERSION,
  SUPPORTED_CAMPAIGN_TYPES,
  SUPPORTED_CAMPAIGN_TYPE_CODES: codes(SUPPORTED_CAMPAIGN_TYPES),
  CONTROLLED_CAMPAIGN_TYPES,
  CONTROLLED_CAMPAIGN_TYPE_CODES: codes(CONTROLLED_CAMPAIGN_TYPES),
  RECORDABLE_CAMPAIGN_TYPES,
  RECORDABLE_CAMPAIGN_TYPE_CODES: codes(RECORDABLE_CAMPAIGN_TYPES),
  CHANNEL_SUPPORT,
  BIDDING_STRATEGIES,
  BIDDING_STRATEGY_CODES: codes(BIDDING_STRATEGIES),
  BUDGET_RELATIONSHIPS,
  BUDGET_RELATIONSHIP_CODES: codes(BUDGET_RELATIONSHIPS),
  DESTINATION_KINDS,
  DESTINATION_KIND_CODES: codes(DESTINATION_KINDS),
  EXCLUSION_DECISIONS,
  EXCLUSION_DECISION_CODES: codes(EXCLUSION_DECISIONS),
  FINDING_SEVERITIES,
  FINDING_GROUPS,
  FINDING_GROUP_CODES: codes(FINDING_GROUPS),
  FINDING_CODES,
  GOAL_COMPATIBILITY,
  BRIEF_LIMITS,
  /* Judges controlled types too; `controlled: true` on the spec says which. */
  campaignType: (code) => RECORDABLE_CAMPAIGN_TYPES.find((t) => t.code === code) || null,
  biddingStrategy: (code) => BIDDING_STRATEGIES.find((b) => b.code === code) || null,
  budgetRelationship: (code) => BUDGET_RELATIONSHIPS.find((b) => b.code === code) || null,
  destinationKind: (code) => DESTINATION_KINDS.find((d) => d.code === code) || null,
  exclusionDecision: (code) => EXCLUSION_DECISIONS.find((e) => e.code === code) || null,
};
