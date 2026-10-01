// constants/marketingCampaignCapabilities.js
//
// WHAT EACH CAMPAIGN TYPE CAN ACTUALLY DO.
//
// ── THE ONE THING THIS FILE EXISTS TO PREVENT ──────────────────────────────
// A campaign builder that shows the same form for every channel. It is the
// natural thing to build and it is wrong in a specific, expensive way: a
// marketer fills in "job title: Procurement Manager" for a Google Search
// campaign, GRAV accepts it, and the campaign runs against nothing. The field
// was there, so it looked like a setting. Nobody finds out until the money is
// gone.
//
// So every setting, for every campaign type, carries a support state and a
// sentence. A builder renders from this table rather than from a designer's
// memory of which channel does what, and a field that cannot be applied is
// either absent or visibly disabled with the reason attached.
//
// ── SIX STATES, NOT TWO ────────────────────────────────────────────────────
// "Supported or not" collapses distinctions that decide entirely different
// things. A setting the channel cannot do is permanent. A setting GRAV has not
// modelled yet is a piece of work. A setting reachable only by uploading an
// audience is a task for the marketer, today, with no code change at all.
// Rendering all three as "unavailable" tells somebody to give up on two things
// they could have had.
//
// ── AND THIS FILE CHANGES NO BEHAVIOUR ─────────────────────────────────────
// It is a declaration. Creation, validation and readiness still belong to the
// contracts that already own them — `marketingDeploymentReadiness`,
// `googleSearchPreflight`, `metaPreflight`, the mappers and the paused-creation
// services. Nothing here loosens a check or enables a campaign type, and the
// two deployable types are exactly the two that were deployable before.
"use strict";

const LEAD_FORM = require("./marketingGoogleLeadForm");

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── DEPLOYABILITY IS DERIVED, NOT DECLARED ─────────────────────────────────
   A hand-maintained boolean saying "this campaign type is ready" is a boolean
   somebody flips while finishing something else. This one is computed from the
   same verified-contract flags the validator reads, so the matrix cannot say a
   type is deployable while the contract says a piece of it is unproven.

   Today the missing piece is ingestion: Google's webhook payload schema has not
   been read, so GRAV cannot receive a submitted lead. A lead-form campaign that
   runs and delivers enquiries nowhere is the precise failure this whole design
   exists to prevent, so the type stays unavailable until that is proven too. */
/* Deployable only when EVERY unverified item is verified: the payload schema, a
   creation in the proof account read back as stopped, and a real enquiry
   delivered end to end. Each flag records an event; none is a judgement about
   code, and no mocked test can set one. */
const LEAD_FORM_DEPLOYABLE = Object.values(LEAD_FORM.UNVERIFIED).every((u) => u.verified === true);

/* ═══════════════════════════════════════════════════════════════════════════
   THE SUPPORT STATES
   ═══════════════════════════════════════════════════════════════════════════ */

const SUPPORT = [
  pair("required", "Required", {
    means: "This campaign type cannot be created without it.",
    settable: true,
    blocksCreation: true,
  }),
  pair("supported", "Supported", {
    means: "GRAV models this and the advertising channel applies it.",
    settable: true,
    blocksCreation: false,
  }),
  /* ── THE STATE PEOPLE COLLAPSE, AND SHOULD NOT ──────────────────────────
     The channel does this; GRAV does not model it yet. It is a piece of work,
     not a limitation, and telling a marketer it is "unavailable" makes them
     stop asking for something they could have. Every entry names what would
     have to be built. */
  pair("not_modelled", "Not available in GRAV yet", {
    means: "The advertising channel supports this. GRAV does not model it yet, so it cannot be part of a plan.",
    settable: false,
    blocksCreation: false,
  }),
  pair("unavailable", "Not possible on this channel", {
    means: "The advertising channel cannot apply this to this campaign type at all.",
    settable: false,
    blocksCreation: false,
  }),
  /* ── THE ONE A B2B ADVERTISER NEEDS MOST ────────────────────────────────
     Job role, seniority, industry and company size are the settings a B2B
     marketer reaches for first, and no advertising channel applies them as
     verified facts. What the channels offer under those names is self-reported
     profile data or an interest cluster, and treating it as a firmographic
     filter is how a campaign for procurement managers reaches people who once
     liked a page about procurement.

     They are reachable, but only by supplying the audience: a customer list,
     a website-visitor audience, or a list bought from somewhere that does
     verify. That is a task for a person today rather than a field in a form,
     and this state says so. */
  pair("requires_external_audience", "Needs an audience you supply", {
    means: "The advertising channel cannot target this directly. It is reachable only by supplying a list or an audience GRAV does not hold yet.",
    settable: false,
    blocksCreation: false,
  }),
  pair("externally_verified", "Checked against the advertising account", {
    means: "GRAV cannot confirm this from the plan alone. It is read back from the advertising account before anything is created.",
    settable: true,
    blocksCreation: false,
  }),
];
const SUPPORT_CODES = codes(SUPPORT);
const SUPPORT_BY_CODE = freeze(Object.fromEntries(SUPPORT.map((s) => [s.code, s])));

/* Settings a builder may render as an input. The rest are shown disabled with
   their reason, or not shown at all — but the reason is always available, so a
   screen never has to invent one. */
const SETTABLE_SUPPORT = freeze(SUPPORT.filter((s) => s.settable).map((s) => s.code));

/* ═══════════════════════════════════════════════════════════════════════════
   THE SECTIONS OF A CAMPAIGN — AND THE BUILDER'S STEPS
   ═══════════════════════════════════════════════════════════════════════════ */

const SECTIONS = [
  pair("goal", "Goal and measurement", {
    step: 1,
    means: "What this campaign is for and how it will be judged.",
  }),
  pair("channel", "Channel and campaign type", {
    step: 2,
    means: "Where it runs. This choice decides every setting that follows.",
  }),
  pair("audience", "Audience and targeting", {
    step: 3,
    means: "Who should see it, and who should not.",
  }),
  pair("budget", "Budget and schedule", {
    step: 4,
    means: "What it may spend, how, and when.",
  }),
  pair("creative", "Creative", {
    step: 5,
    means: "What people actually see.",
  }),
  pair("tracking", "Tracking", {
    step: 6,
    means: "How the result will be attributed and counted.",
  }),
  pair("review", "Review", {
    step: 7,
    means: "Everything in one place, with whatever is not ready called out.",
  }),
  pair("approval", "Approval", {
    step: 8,
    means: "A named person agreeing, before anything is created.",
  }),
];
const SECTION_CODES = codes(SECTIONS);

/* ═══════════════════════════════════════════════════════════════════════════
   THE PROVIDER-NEUTRAL SETTING VOCABULARY
   ═══════════════════════════════════════════════════════════════════════════
   GRAV's words, not a channel's. `ad group` and `ad set` are the same rung of
   two different ladders; a builder should not have to know which one it is
   talking to. Each setting is named once here and referenced by code in the
   matrix below, so adding a channel is a column rather than a rewrite. */

const setting = (code, label, section, means, extra = {}) =>
  freeze({ code, label, section, means, ...extra });

const SETTINGS = freeze([
  /* ── 1. GOAL AND MEASUREMENT ─────────────────────────────────────────── */
  setting("campaign_name", "Campaign name", "goal", "What this campaign is called in GRAV."),
  setting("business_objective", "Business objective", "goal", "What the business wants out of it."),
  setting("primary_conversion_goal", "Primary conversion goal", "goal",
    "The one outcome this campaign will be judged by, agreed before the spending rather than chosen afterwards."),
  setting("secondary_signals", "Secondary signals", "goal",
    "Other outcomes worth watching. They do not decide whether the campaign worked."),
  setting("attribution_basis", "Attribution basis", "goal",
    "Whose count of a conversion is being used, and over what window. Without it, two channels' figures look comparable and are not."),
  setting("revenue_measurement", "Value of conversions", "goal",
    "What a conversion was worth, where somebody configured a value for it."),

  /* ── 2. DESTINATION ──────────────────────────────────────────────────── */
  setting("destination_url", "Destination", "goal",
    "The GRAV page a click goes to."),
  setting("native_lead_form", "Native lead form", "goal",
    "A form hosted by the advertising channel itself, rather than a page on the GRAV site."),

  /* ── 3. AUDIENCE AND TARGETING ───────────────────────────────────────── */
  setting("geo_country", "Countries", "audience", "Whole countries."),
  setting("geo_state", "States and regions", "audience", "Regions inside a country."),
  setting("geo_city", "Cities", "audience", "Named cities."),
  setting("geo_postal", "Postal areas", "audience", "Postcode areas."),
  setting("geo_radius", "Radius around a point", "audience", "Everybody within a distance of a place."),
  setting("geo_exclusion", "Excluded locations", "audience",
    "Places this campaign must not reach. Stored as an exclusion rather than left out of the inclusions, so a reader can see it was a decision."),
  setting("languages", "Languages", "audience", "The languages the audience reads."),
  setting("age_range", "Age range", "audience", "Only where the channel supports it and the law allows it."),
  setting("gender", "Gender", "audience", "Only where the channel supports it and the law allows it."),
  setting("interests", "Interests", "audience", "Subjects people have shown interest in."),
  setting("behaviours", "Behaviours", "audience", "Things people have done, as the channel reports them."),
  setting("job_role", "Job role", "audience", "What somebody does."),
  setting("job_seniority", "Seniority", "audience", "How senior they are."),
  setting("industry", "Industry", "audience", "What their employer does."),
  setting("company_size", "Company size", "audience", "How large their employer is."),
  setting("keyword_themes", "Keyword themes", "audience", "The subjects somebody is searching for."),
  setting("keyword_exact", "Exact keywords", "audience", "Specific searches, matched closely."),
  setting("negative_keywords", "Negative keywords", "audience",
    "Searches this campaign must not answer. The single most effective way to stop a search campaign wasting money."),
  setting("existing_customer_exclusion", "Exclude existing customers", "audience",
    "So a campaign for new business does not spend on people who already buy."),
  setting("website_retargeting", "Website visitors", "audience", "People who have already been to the site."),
  setting("uploaded_audience", "Your own list", "audience", "A list of people you supply."),
  setting("lookalike_audience", "Similar audiences", "audience", "People the channel judges similar to a list you supply."),
  setting("device_targeting", "Devices", "audience", "Which devices it may appear on."),
  setting("placement_control", "Placements", "audience", "Where inside the channel it may appear."),
  setting("audience_expansion", "Audience expansion", "audience",
    "Whether the channel may show the advertisement outside the audience that was approved. A decision, never an omission."),

  /* ── 4. BUDGET, BIDDING AND SCHEDULE ─────────────────────────────────── */
  setting("budget_daily", "Daily budget", "budget", "What it may spend each day."),
  setting("budget_total", "Total budget", "budget", "What it may spend in all."),
  setting("currency", "Currency", "budget", "The currency the advertising account bills in."),
  setting("bid_strategy", "Bid strategy", "budget", "How the channel is told to spend the budget."),
  setting("bid_limit", "Bid limit", "budget", "A ceiling on what one click or result may cost."),
  setting("start_date", "Start date", "budget", "When it may begin."),
  setting("end_date", "End date", "budget", "When it must stop."),
  setting("dayparting", "Days and times", "budget", "The hours of the week it may run."),
  setting("timezone", "Timezone", "budget", "The advertising account's own reporting day."),
  setting("frequency_cap", "Frequency limit", "budget", "How often one person may see it."),
  setting("spend_safeguard", "Spend safeguards", "budget", "A ceiling GRAV enforces, separate from the channel's."),
  setting("budget_change_approval", "Budget-change approval", "budget",
    "Who agreed to each change of the budget, and when."),

  /* ── 5. CREATIVE ─────────────────────────────────────────────────────── */
  setting("headlines", "Headlines", "creative", "Short lines, several of them, which the channel combines."),
  setting("descriptions", "Descriptions", "creative", "Supporting lines."),
  setting("primary_text", "Primary text", "creative", "The main body of the advertisement."),
  setting("image", "Image", "creative", "A still image."),
  setting("video", "Video", "creative", "A video."),
  setting("call_to_action", "Call to action", "creative", "The button's words."),
  setting("creative_variants", "Variants", "creative",
    "More than one version, so they can be compared on evidence rather than opinion."),
  setting("placement_preview", "Preview", "creative", "What it will look like in each placement."),
  setting("content_library_ref", "Content library", "creative",
    "The library item and the exact version this campaign used, so a later edit does not silently rewrite what ran."),
  setting("policy_review", "Policy review", "creative",
    "Whether the channel will accept it. Attached to the exact creative that has the problem, never to the campaign as a whole."),

  /* ── 6. TRACKING ─────────────────────────────────────────────────────── */
  setting("tracking_identity", "Campaign tag", "tracking",
    "The identifier that travels in the destination URL so analytics can tell this campaign from every other."),
  setting("conversion_tracking", "Conversion tracking", "tracking",
    "Whether the channel can see the outcome it is being asked to optimise for."),
]);

const SETTING_CODES = codes(SETTINGS);
const SETTING_BY_CODE = freeze(Object.fromEntries(SETTINGS.map((s) => [s.code, s])));
const SETTINGS_IN_SECTION = freeze(Object.fromEntries(
  SECTION_CODES.map((sec) => [sec, freeze(SETTINGS.filter((s) => s.section === sec).map((s) => s.code))]),
));

/* ═══════════════════════════════════════════════════════════════════════════
   THE CAMPAIGN TYPES
   ═══════════════════════════════════════════════════════════════════════════
   `deployable` is the load-bearing field and it is deliberately conservative.
   Exactly two types are deployable, and they are the same two that were
   deployable before this file existed: nothing here enables a campaign type.

   The rest are declared so a builder can show them, greyed, with the actual
   reason — which is better than a short list that makes a marketer think GRAV
   cannot do the thing at all. Each one names what is missing, so adding it
   later is a piece of work rather than a redesign. */

const CAMPAIGN_TYPES = [
  pair("google_search", "Search", {
    channel: "google_ads",
    channelTerm: "Search",
    means: "Text advertisements on search results, sending people to a GRAV page.",
    deployable: true,
    audienceModel: "intent",
    audienceMeans: "People are reached because of what they searched for. Who they are matters far less than what they typed.",
  }),
  pair("meta_traffic_single_image", "Website traffic, single image", {
    channel: "meta_ads",
    channelTerm: "Traffic",
    means: "One image advertisement sending people to a GRAV page.",
    deployable: true,
    audienceModel: "profile",
    audienceMeans: "People are reached because of who the channel believes they are. Nobody in this audience asked for anything.",
  }),

  /* ── DECLARED, NOT DEPLOYABLE ──────────────────────────────────────────── */
  pair("google_lead_form", "Lead form", {
    channel: "google_ads",
    channelTerm: "Lead form asset",
    means: "A form hosted by Google, attached to a Search campaign, so somebody can enquire without leaving the results page.",
    deployable: LEAD_FORM_DEPLOYABLE,
    /* ── WHAT IS DONE, AND WHAT IS NOT ────────────────────────────────────
       The local half exists and is tested: Google's documented form contract
       is encoded in `constants/marketingGoogleLeadForm.js` from its own
       reference pages, and `googleLeadFormDefinition.js` validates a form
       against it — required content, the field-exclusivity rule, the
       five-question limit, the conversion-bidding and conversion-goal rules
       that decide whether a form serves at all, and the countries where it
       does not.

       Deployability is still derived from `webhookPayloadSchema.verified`,
       which stays false until a real delivery confirms the payload GRAV was
       built against. */
    /* ── WHERE THE BOUNDARY IS NOW ─────────────────────────────────────────
       Receiving, processing and recovering a lead are built (3A–3C), and so
       is creating the campaign and its form, stopped (this slice) — but only
       into the advertising account an administrator names as the proof
       account. What remains is not code: a creation actually carried out
       there and read back, and a real enquiry from it arriving at GRAV. Until
       both are recorded, the type is not offered anywhere else. */
    blockedBy: "GRAV can create a Search campaign with its lead form, stopped, and receive, process and recover the enquiries it collects — but it has not yet been proven on a real account. Until a creation in the proof account and a real enquiry from it have both been confirmed, it is created only there.",
    needs: freeze([
      "a lead-form campaign created, stopped, in the proof account named by an administrator, and read back as stopped with its form attached",
      "a real enquiry from that form delivered to GRAV and processed end to end",
      /* ── AN EXTERNAL PREREQUISITE, NOT SOMETHING GRAV CAN BUILD ─────────
         Google ended developer tokens on 9 September 2026. Access now belongs
         to the Google Cloud project that owns GRAV's OAuth client. */
      "an administrator confirming that the Google Cloud project behind GRAV's Google sign-in has Google Ads API access to production accounts (Explorer level or above)",
    ]),
    localContract: freeze({
      complete: true,
      means: "The form definition, its validation and Google's eligibility rules are modelled and tested.",
    }),
    audienceModel: "intent",
  }),
  pair("meta_lead_form", "Lead advertisement", {
    channel: "meta_ads",
    channelTerm: "Leads",
    means: "A form hosted by Meta, so somebody can enquire without leaving the feed.",
    deployable: false,
    blockedBy: "GRAV does not model a lead form hosted by an advertising channel. Enquiries would be collected by Meta and would reach nobody, because there is nothing to deliver them into.",
    needs: freeze([
      "a lead-form definition in the content library",
      "a way to receive submitted leads from the channel",
      "a route from a received lead into the prospect-handover contract",
    ]),
    audienceModel: "profile",
  }),
];
const CAMPAIGN_TYPE_CODES = codes(CAMPAIGN_TYPES);
const CAMPAIGN_TYPE_BY_CODE = freeze(Object.fromEntries(CAMPAIGN_TYPES.map((t) => [t.code, t])));
const DEPLOYABLE_CAMPAIGN_TYPES = freeze(CAMPAIGN_TYPES.filter((t) => t.deployable).map((t) => t.code));

/* ═══════════════════════════════════════════════════════════════════════════
   THE MATRIX
   ═══════════════════════════════════════════════════════════════════════════
   One entry per campaign type per setting. A `why` is required on everything
   that is not plainly supported, because "unavailable" with no sentence is the
   thing a marketer escalates. */

const s = (support, why = "", extra = {}) => freeze({ support, why, ...extra });

const REQUIRED = s("required");
const SUPPORTED = s("supported");

/* Reasons written once and shared, so the same limitation reads identically
   wherever it appears.

   ── EACH ONE STANDS ALONE ───────────────────────────────────────────────
   Every `why` is rendered beside one disabled field, on its own. "As above"
   has no referent there — the reader is looking at a single tooltip, not a
   list — so no reason in this file refers to another one. */
const WHY = freeze({
  NO_FIRMOGRAPHICS: "No advertising channel verifies where somebody works or what they do. What the channels offer under these names is self-reported profile data or an interest cluster, so a campaign aimed at procurement managers would reach people who once showed an interest in procurement. Reach this audience with a list you supply instead.",
  SEARCH_IS_INTENT: "A search campaign reaches people because of what they typed, not because of who the channel believes they are.",
  NO_KEYWORDS: "This channel does not match on what somebody searched for.",
  NOT_MODELLED_AUDIENCE: "GRAV does not yet hold advertising audiences, so it cannot name one in a plan.",
  NEEDS_LIST: "Reachable by supplying a list of people. GRAV does not yet hold advertising audiences, so this is done in the advertising account today.",
  NO_LEAD_FORM: "This campaign type sends people to a GRAV page. It has no channel-hosted form.",
  NOT_MODELLED_YET: "The advertising channel supports this. GRAV does not model it yet.",
  CHANNEL_DECIDES_PLACEMENT: "This campaign type does not let GRAV choose placements individually.",
});

const MATRIX = freeze({
  google_search: freeze({
    /* Goal */
    campaign_name: REQUIRED,
    business_objective: REQUIRED,
    primary_conversion_goal: REQUIRED,
    secondary_signals: s("not_modelled", "GRAV records one goal per plan. Secondary signals are read from performance rather than declared."),
    attribution_basis: s("externally_verified", "The attribution window belongs to the conversion action configured in the advertising account. GRAV reads it rather than setting it."),
    revenue_measurement: s("externally_verified", "Reported only where somebody configured a value on the conversion action."),
    destination_url: REQUIRED,
    native_lead_form: s("unavailable", WHY.NO_LEAD_FORM),

    /* Audience */
    geo_country: REQUIRED,
    geo_state: SUPPORTED,
    geo_city: SUPPORTED,
    geo_postal: SUPPORTED,
    geo_radius: s("not_modelled", WHY.NOT_MODELLED_YET),
    geo_exclusion: REQUIRED,
    languages: REQUIRED,
    age_range: s("unavailable", `${WHY.SEARCH_IS_INTENT} Age can only adjust bids here, which is not targeting.`),
    gender: s("unavailable", `${WHY.SEARCH_IS_INTENT} Gender can only adjust bids here, which is not targeting.`),
    interests: s("not_modelled", "Google offers audience segments on Search as an observation. GRAV does not model them."),
    behaviours: s("not_modelled", "Google reports behaviours as audience segments on Search. GRAV does not model them."),
    job_role: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    job_seniority: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    industry: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    company_size: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    keyword_themes: REQUIRED,
    keyword_exact: SUPPORTED,
    negative_keywords: SUPPORTED,
    existing_customer_exclusion: s("requires_external_audience", WHY.NEEDS_LIST),
    website_retargeting: s("requires_external_audience", WHY.NOT_MODELLED_AUDIENCE),
    uploaded_audience: s("requires_external_audience", WHY.NEEDS_LIST),
    lookalike_audience: s("unavailable", "Google withdrew similar segments. A list you supply is the replacement."),
    device_targeting: s("not_modelled", WHY.NOT_MODELLED_YET),
    placement_control: s("unavailable", "A search campaign appears on search results. There are no placements to choose between."),
    audience_expansion: s("not_modelled", "Search has no audience-expansion switch of the kind Meta has."),

    /* Budget */
    budget_daily: REQUIRED,
    budget_total: s("supported", "Recorded on the plan. Google itself is told a daily budget."),
    currency: s("externally_verified", "Set by the advertising account, not by the plan. GRAV reads it back."),
    bid_strategy: REQUIRED,
    bid_limit: SUPPORTED,
    start_date: REQUIRED,
    end_date: REQUIRED,
    dayparting: s("not_modelled", WHY.NOT_MODELLED_YET),
    timezone: s("externally_verified", "The advertising account's own reporting timezone. GRAV reads it rather than setting it."),
    frequency_cap: s("unavailable", "Search has no frequency cap: somebody searching twice should find the advertisement twice."),
    spend_safeguard: s("not_modelled", "GRAV does not yet enforce a ceiling of its own beyond the plan's budget."),
    budget_change_approval: SUPPORTED,

    /* Creative */
    headlines: REQUIRED,
    descriptions: REQUIRED,
    primary_text: s("unavailable", "A search advertisement is headlines and descriptions."),
    image: s("unavailable", "A text advertisement carries no image."),
    video: s("unavailable", "A text advertisement carries no video."),
    call_to_action: s("unavailable", "Google composes the call to action from the advertisement text."),
    creative_variants: s("not_modelled", "Google combines several headlines and descriptions itself. GRAV does not yet model separate variants to compare."),
    placement_preview: s("not_modelled", WHY.NOT_MODELLED_YET),
    content_library_ref: SUPPORTED,
    policy_review: s("externally_verified", "Google decides whether an advertisement is acceptable, after it is created."),

    /* Tracking */
    tracking_identity: REQUIRED,
    conversion_tracking: s("externally_verified", "Read back from the advertising account before anything is created."),
  }),

  meta_traffic_single_image: freeze({
    campaign_name: REQUIRED,
    business_objective: REQUIRED,
    primary_conversion_goal: REQUIRED,
    secondary_signals: s("not_modelled", "GRAV records one goal per plan. Secondary signals are read from performance rather than declared."),
    attribution_basis: s("externally_verified", "Meta's attribution setting belongs to the advertising account."),
    revenue_measurement: s("externally_verified", "Reported only where a pixel sends a value."),
    destination_url: REQUIRED,
    native_lead_form: s("unavailable", `${WHY.NO_LEAD_FORM} A lead advertisement is a separate campaign type, declared and not yet available.`),

    geo_country: REQUIRED,
    geo_state: SUPPORTED,
    geo_city: SUPPORTED,
    geo_postal: SUPPORTED,
    geo_radius: s("not_modelled", WHY.NOT_MODELLED_YET),
    geo_exclusion: REQUIRED,
    languages: REQUIRED,
    age_range: SUPPORTED,
    gender: SUPPORTED,
    interests: s("not_modelled", "Meta's detailed targeting. GRAV models one explicitly broad audience today and nothing narrower."),
    behaviours: s("not_modelled", "Part of Meta's detailed targeting. GRAV models one explicitly broad audience today and nothing narrower."),
    job_role: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    job_seniority: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    industry: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    company_size: s("requires_external_audience", WHY.NO_FIRMOGRAPHICS),
    keyword_themes: s("unavailable", WHY.NO_KEYWORDS),
    keyword_exact: s("unavailable", WHY.NO_KEYWORDS),
    negative_keywords: s("unavailable", WHY.NO_KEYWORDS),
    existing_customer_exclusion: s("requires_external_audience", WHY.NEEDS_LIST),
    website_retargeting: s("requires_external_audience", WHY.NOT_MODELLED_AUDIENCE),
    uploaded_audience: s("requires_external_audience", WHY.NEEDS_LIST),
    lookalike_audience: s("requires_external_audience", "Meta builds these from a list you supply. GRAV does not yet hold one."),
    device_targeting: s("not_modelled", WHY.NOT_MODELLED_YET),
    placement_control: s("not_modelled", "Meta lets an advertiser choose placements. GRAV uses the channel's automatic placements and does not model a choice."),
    audience_expansion: REQUIRED,

    budget_daily: REQUIRED,
    budget_total: s("supported", "Recorded on the plan. Meta is told a daily budget on the ad set."),
    currency: s("externally_verified", "Set by the advertising account."),
    bid_strategy: REQUIRED,
    bid_limit: SUPPORTED,
    start_date: REQUIRED,
    end_date: REQUIRED,
    dayparting: s("not_modelled", "Meta supports a schedule on a lifetime budget. GRAV does not model it."),
    timezone: s("externally_verified", "The advertising account's own reporting timezone."),
    frequency_cap: s("not_modelled", WHY.NOT_MODELLED_YET),
    spend_safeguard: s("not_modelled", "GRAV does not yet enforce a ceiling of its own."),
    budget_change_approval: SUPPORTED,

    headlines: SUPPORTED,
    descriptions: s("supported", "Shown as the link description."),
    primary_text: REQUIRED,
    image: REQUIRED,
    video: s("unavailable", "This campaign type is one still image. A video advertisement is a separate type."),
    call_to_action: REQUIRED,
    creative_variants: s("not_modelled", "One image advertisement per campaign today."),
    placement_preview: s("not_modelled", WHY.NOT_MODELLED_YET),
    content_library_ref: SUPPORTED,
    policy_review: s("externally_verified", "Meta reviews an advertisement after it is created."),

    tracking_identity: REQUIRED,
    conversion_tracking: s("externally_verified", "Read back from the advertising account before anything is created."),
  }),
});

/* A type that is declared but not deployable has no column: publishing one
   would describe settings for a campaign nobody can create, and a builder
   would render a form that leads nowhere. `blockedBy` is what it gets. */
const capabilityFor = (campaignType, settingCode) => {
  const column = MATRIX[campaignType];
  if (!column) return null;
  return column[settingCode] || null;
};

const settingsBySupport = (campaignType, support) => {
  const column = MATRIX[campaignType];
  if (!column) return [];
  return Object.entries(column).filter(([, v]) => v.support === support).map(([k]) => k);
};

/* ═══════════════════════════════════════════════════════════════════════════
   LIFECYCLE
   ═══════════════════════════════════════════════════════════════════════════
   The complete professional lifecycle, declared in full so the read contract
   does not have to change when the missing states arrive.

   `reachable` is what matters and it is conservative. The five states that
   exist today are reachable; `scheduled`, `active`, `paused`, `completed` and
   `archived` are declared and are NOT reachable, because every one of them
   either begins or ends spending. Activation is its own safety contract and it
   does not exist yet.

   A frontend may render the whole sequence — showing somebody where a campaign
   is in a process is useful — but it must not offer a control for an
   unreachable state. `offersControl` says so per state. */
const LIFECYCLE = [
  pair("draft", "Draft", { reachable: true, order: 1, offersControl: true, means: "Being written." }),
  pair("ready_for_review", "Ready for review", {
    reachable: false, order: 2, offersControl: false,
    means: "The author considers it finished and wants a colleague to read it before it goes for approval.",
    blockedBy: "GRAV moves a plan straight from draft to awaiting approval today. This step is declared so it can be added without changing the sequence.",
  }),
  pair("awaiting_approval", "Awaiting approval", { reachable: true, order: 3, offersControl: true, means: "Submitted and frozen." }),
  pair("approved", "Approved", {
    reachable: true, order: 4, offersControl: true,
    means: "An administrator agreed to it. Nothing has been created in any advertising channel, no budget is committed and no money can be spent because of it.",
  }),
  pair("returned", "Returned for changes", { reachable: true, order: 4, offersControl: true, means: "Sent back with a reason. Editable again." }),
  pair("rejected", "Rejected", { reachable: true, order: 4, offersControl: true, terminal: true, means: "Declined. A new plan is the way forward." }),
  pair("cancelled", "Cancelled", { reachable: true, order: 9, offersControl: true, terminal: true, means: "Withdrawn. Kept for the record." }),

  /* ── EVERYTHING BELOW SPENDS MONEY, OR STOPS SOMETHING THAT IS ────────── */
  pair("scheduled", "Scheduled", {
    reachable: false, order: 5, offersControl: false,
    means: "Created in the advertising channel, stopped, and due to start on its own.",
    blockedBy: "A campaign that starts by itself is a campaign that begins spending without anybody present. That needs the activation safety contract, which does not exist yet.",
  }),
  pair("active", "Running", {
    reachable: false, order: 6, offersControl: false,
    means: "Delivering and able to spend.",
    blockedBy: "Activation is the step that spends money and deserves its own authority. Until that contract exists, GRAV creates campaigns stopped and offers no control that starts one.",
  }),
  pair("paused", "Paused", {
    reachable: false, order: 7, offersControl: false,
    means: "Was running and has been stopped by somebody.",
    blockedBy: "Nothing can reach this state because nothing can be running. Note this is NOT the same as a campaign created stopped, which has never run at all.",
  }),
  pair("completed", "Completed", {
    reachable: false, order: 8, offersControl: false,
    means: "Ran to its end date and stopped on its own.",
    blockedBy: "Nothing has run, so nothing can have finished.",
  }),
  pair("archived", "Archived", {
    reachable: false, order: 10, offersControl: false, terminal: true,
    means: "Put away. Out of the ordinary list, still readable.",
    blockedBy: "GRAV does not model archiving yet. Cancelled is the nearest terminal state today.",
  }),
];
const LIFECYCLE_CODES = codes(LIFECYCLE);
const REACHABLE_LIFECYCLE = freeze(LIFECYCLE.filter((l) => l.reachable).map((l) => l.code));
const LIFECYCLE_BY_CODE = freeze(Object.fromEntries(LIFECYCLE.map((l) => [l.code, l])));

/* ── WHAT THE CURRENT SLICE STOPS AT, STATED ONCE ───────────────────────── */
const DELIVERY_BOUNDARY = freeze({
  createsDelivering: false,
  offersActivation: false,
  means: "GRAV creates every campaign stopped and confirms it is stopped by reading it back. Nothing in this contract starts a campaign, and no control to start one exists.",
  why: "Creating and starting are different decisions with different consequences. A campaign that exists but cannot spend is recoverable; one that is spending is not.",
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE READS A CAMPAIGN MANAGER NEEDS
   ═══════════════════════════════════════════════════════════════════════════
   Declared as a contract so Lane B can build against the full shape and so
   each one arrives without renaming anything. `available` says which are served
   today. */
const MANAGEMENT_READS = [
  pair("inventory", "Campaigns and filters", { available: true, servedBy: "GET /campaign-drafts" }),
  pair("status_schedule", "Status and schedule", { available: true, servedBy: "GET /campaign-drafts/:id" }),
  pair("core_metrics", "Spend, impressions, clicks, CTR, CPC, conversions", {
    available: true, servedBy: "GET /campaign-drafts/:id/performance",
  }),
  pair("cost_per_outcome", "Cost per conversion and conversion value", {
    available: true,
    servedBy: "GET /campaign-drafts/:id/performance",
    caveat: "Cost per conversion is published only where the figures support it. Conversion value only where somebody configured one.",
  }),
  pair("daily_trend", "Daily trend", { available: true, servedBy: "GET /campaign-drafts/:id/performance" }),
  pair("readiness", "Readiness and policy problems", { available: true, servedBy: "GET /campaign-drafts/:id/readiness" }),
  pair("approval_history", "Approval history", { available: true, servedBy: "GET /campaign-drafts/:id" }),
  pair("change_history", "Change history", { available: true, servedBy: "GET /campaign-drafts/:id/history" }),
  pair("sales_outcomes", "Marketing-to-Sales outcomes", { available: true, servedBy: "GET /overview" }),
  pair("channel_connection", "Channel connection state", { available: true, servedBy: "GET /advertising-accounts/:channel" }),

  pair("breakdowns", "Audience, creative, location and device breakdowns", {
    available: false,
    blockedBy: "GRAV reads one row per campaign per day. A breakdown needs a different read from each channel, and the figures do not add up to the campaign total in the way people expect — a person in two age bands is counted in both.",
  }),
  pair("budget_pacing", "Budget pacing", {
    available: true,
    servedBy: "GET /campaign-drafts/:id/pacing",
    caveat: "A verdict appears only when the approved budget, schedule, currency and settled daily figures support one; otherwise it says why not. Each channel is paced separately and never added together.",
  }),
  pair("lead_volume", "Lead volume and qualification", {
    available: false,
    blockedBy: "GRAV counts prospects handed to Sales, not leads attributed to a campaign. Joining a handover back to the campaign that produced it needs an attribution contract that does not exist.",
  }),
];
const MANAGEMENT_READ_CODES = codes(MANAGEMENT_READS);

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT A FUTURE INTELLIGENCE LAYER MAY DO
   ═══════════════════════════════════════════════════════════════════════════
   Declared so the campaign contract carries the evidence each one would need,
   rather than being retrofitted later. NOTHING HERE IS IMPLEMENTED and no
   model is called anywhere in this contract.

   Every entry names its evidence, and every entry requires a person. That is
   the existing Campaign Health rule and it holds here: the assistant may
   suggest that somebody looks at something. It may not act. */
const INTELLIGENCE_READINESS = [
  pair("targeting_refinement", "Recommend targeting refinements", {
    needsEvidence: freeze(["breakdowns", "core_metrics"]),
    requiresHumanApproval: true,
  }),
  pair("negative_keywords", "Suggest negative keywords", {
    needsEvidence: freeze(["search_terms"]),
    requiresHumanApproval: true,
    blockedBy: "GRAV does not read search terms. Without them a suggestion would be a guess.",
  }),
  pair("creative_fatigue", "Detect creative fatigue", {
    needsEvidence: freeze(["daily_trend", "creative_variants"]),
    requiresHumanApproval: true,
  }),
  pair("lead_quality", "Detect poor lead quality", {
    needsEvidence: freeze(["sales_outcomes", "lead_volume"]),
    requiresHumanApproval: true,
  }),
  pair("variant_comparison", "Compare variants", {
    needsEvidence: freeze(["creative_variants", "core_metrics"]),
    requiresHumanApproval: true,
  }),
  pair("spend_anomaly", "Identify overspending or underspending", {
    needsEvidence: freeze(["budget_pacing", "daily_trend"]),
    requiresHumanApproval: true,
  }),
  pair("budget_reallocation", "Recommend budget reallocation", {
    needsEvidence: freeze(["core_metrics", "cost_per_outcome"]),
    requiresHumanApproval: true,
  }),
];
const INTELLIGENCE_READINESS_CODES = codes(INTELLIGENCE_READINESS);

const INTELLIGENCE_RULES = freeze({
  callsAModel: false,
  mayAct: false,
  means: "Nothing in this contract calls a model. When the intelligence layer reaches campaigns it will explain figures GRAV calculated, cite the evidence for every statement, and require a person to approve any consequential change.",
});

module.exports = freeze({
  SUPPORT,
  SUPPORT_CODES,
  SUPPORT_BY_CODE,
  SETTABLE_SUPPORT,

  SECTIONS,
  SECTION_CODES,

  SETTINGS,
  SETTING_CODES,
  SETTING_BY_CODE,
  SETTINGS_IN_SECTION,

  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_CODES,
  CAMPAIGN_TYPE_BY_CODE,
  DEPLOYABLE_CAMPAIGN_TYPES,

  MATRIX,
  capabilityFor,
  settingsBySupport,

  LIFECYCLE,
  LIFECYCLE_CODES,
  LIFECYCLE_BY_CODE,
  REACHABLE_LIFECYCLE,
  DELIVERY_BOUNDARY,

  MANAGEMENT_READS,
  MANAGEMENT_READ_CODES,

  INTELLIGENCE_READINESS,
  INTELLIGENCE_READINESS_CODES,
  INTELLIGENCE_RULES,
});
