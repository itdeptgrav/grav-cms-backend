// constants/marketingMetaDeployment.js
//
// THE ONE META CAMPAIGN SHAPE GRAV WILL SUPPORT, AND EVERYTHING IT WILL NOT.
//
// ── WHY THE UNSUPPORTED LIST IS AS LONG AS IT IS ───────────────────────────
// Meta's ad platform is not one product. A carousel, a lead form, a catalogue
// ad and an Advantage+ campaign each have their own objects, their own required
// fields, their own delivery behaviour and their own money. A mapper that
// "approximately" turned a carousel plan into a single-image ad would produce a
// campaign nobody designed, spending a budget somebody approved for something
// else — and it would look entirely normal on every screen.
//
// So exactly one shape is supported, and every other shape is refused BY NAME
// internally. The names below are GRAV's internal capability vocabulary: they
// let a refusal be precise in a log and in a test. A marketer is told only that
// the plan type they chose is not supported yet, because naming Meta features
// GRAV cannot do is a roadmap published by accident.
//
// ── AND WHY NOTHING HERE CAN BE CREATED YET ────────────────────────────────
// Section 4 of this file's reason for existing: GRAV's content library holds
// emails, forms and landing pages. It holds no advertising image — nothing with
// a content hash, dimensions, a byte size, a rights state or a readable binary.
// Meta will not create an image ad without a real image, and GRAV cannot invent
// one. `IMAGE_ASSET_CONTRACT` is what would have to exist; until it does,
// `creationReady` is false and no mutation is reachable.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

const CHANNEL = "meta_ads";
const CAMPAIGN_TYPE = "meta_traffic_single_image";

/* ═══════════════════════════════════════════════════════════════════════════
   THE FROZEN MVP CONTRACT
   ═══════════════════════════════════════════════════════════════════════════ */

/* Every field the one supported shape requires, and what each must be. A plan
   missing any of them is blocked by name; a plan carrying something outside
   these is refused rather than trimmed to fit. */
const MVP_CONTRACT = freeze({
  channel: CHANNEL,
  campaignType: CAMPAIGN_TYPE,

  /* Meta's own word for the objective, and GRAV's. Written down rather than
     chosen at mapping time, because an objective decides how Meta spends the
     budget and "whatever the platform defaults to" is not a decision anybody
     made. */
  objective: freeze({
    grav: "website_traffic",
    provider: "OUTCOME_TRAFFIC",
    means: "Meta shows the advertisement to people it expects to visit the destination.",
  }),

  /* The optimisation goal inside the ad set. Separate from the objective, and
     separately explicit: an objective of traffic still leaves Meta a choice
     between optimising for link clicks and for landing-page views, and those
     buy different things with the same money. */
  optimisation: freeze({
    required: true,
    supported: freeze([
      pair("link_clicks", "Clicks on the link", {
        provider: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        means: "Meta aims for as many clicks as the budget allows.",
      }),
      pair("landing_page_views", "Visits that actually load the page", {
        provider: "LANDING_PAGE_VIEWS",
        billingEvent: "IMPRESSIONS",
        /* Needs the pixel: Meta cannot count a landing-page view it cannot
           observe, so this option is only honest when tracking is configured. */
        needsTrackingIdentity: true,
        means: "Meta aims for people who wait for the page to load, not just taps.",
      }),
    ]),
  }),

  creative: freeze({
    images: 1,
    primaryTexts: 1,
    headlines: 1,
    callsToAction: 1,
    destinations: 1,
  }),

  structure: freeze({
    campaigns: 1,
    adSets: 1,
    creatives: 1,
    ads: 1,
  }),

  /* Explicit, all of them. Each has a Meta default, and each of those defaults
     decides how money is spent. */
  requires: freeze([
    "objective",
    "optimisation",
    "audience",
    "schedule",
    "budgetBasis",
    "budgetCurrency",
    "destination",
    "creativeImage",
    "primaryText",
    "headline",
    "callToAction",
    "specialAdCategory",
    "trackingIdentity",
  ]),
});

/* ── WHAT GRAV DOES NOT DO, BY NAME ─────────────────────────────────────────
   Internal vocabulary. A user-facing refusal says only that the selected plan
   type is not supported yet — naming Meta features GRAV cannot do would publish
   a roadmap nobody wrote and invite somebody to ask for one. */
const UNSUPPORTED_SHAPES = [
  pair("video", "Video advertisement"),
  pair("carousel", "Carousel"),
  pair("catalogue", "Catalogue / dynamic product ads"),
  pair("lead_form", "Lead form"),
  pair("messages", "Messaging destination"),
  pair("app_install", "App install"),
  pair("awareness", "Awareness objective"),
  pair("sales_conversion", "Sales / conversion optimisation"),
  pair("advantage_plus", "Advantage+ campaign types"),
  pair("dynamic_creative", "Dynamic creative"),
  pair("multiple_ads", "More than one advertisement"),
  pair("multiple_ad_sets", "More than one ad set"),
  pair("campaign_budget_optimisation", "Automated budget redistribution across ad sets"),
];
const UNSUPPORTED_SHAPE_CODES = codes(UNSUPPORTED_SHAPES);

/* ── THE ONE SENTENCE A MARKETER GETS ───────────────────────────────────────
   Deliberately the same for every unsupported shape. */
const UNSUPPORTED_PUBLIC_MESSAGE =
  "GRAV cannot prepare this kind of campaign for this channel yet. The only shape it supports is a website-traffic campaign with a single image.";

/* ═══════════════════════════════════════════════════════════════════════════
   THE ADVERTISING IMAGE THAT DOES NOT EXIST YET
   ───────────────────────────────────────────────────────────────────────────
   GRAV's content library holds emails, forms and landing pages. None of them is
   an advertising image, and none carries what one needs.

   Four things a marketer might reasonably offer instead, and why each is
   refused rather than accepted with a caveat:

     An email's hero image. It is a URL inside an email body that the marketing
     engine may rewrite, expire or track. Nothing guarantees it will resolve
     tomorrow, and Meta stores its own copy at upload time — so a campaign would
     carry an image nobody can point back at.

     An arbitrary URL. GRAV would be asking Meta to fetch a picture from an
     address GRAV does not control, has never inspected, and cannot prove the
     company has the right to advertise with. It could be anything, including
     something that gets the account restricted.

     An attachment. No dimensions, no content hash, no rights state, often the
     wrong format, and no stable identifier to reconcile against later.

     A free-text reference. "The winter hero shot" is an instruction to a
     person, not an asset.

   So this is the contract a future asset library must satisfy. It is DEFINED
   here and built nowhere: the point of writing it down now is that the preflight
   can name precisely what is missing instead of failing vaguely.
   ═══════════════════════════════════════════════════════════════════════════ */

const IMAGE_ASSET_CONTRACT = [
  pair("assetId", "A permanent GRAV asset identifier", {
    means: "Immutable. The same identifier means the same bytes for ever, so a campaign can be reconciled against what was approved.",
  }),
  pair("companyId", "The company that owns it", {
    means: "Every selector carries it. One company's advertising image cannot be used by another.",
  }),
  pair("mimeType", "The file type", {
    means: "Meta accepts a short list. A file whose type GRAV has not checked is a refusal halfway through a creation.",
  }),
  pair("width", "Width in pixels", {
    means: "Meta refuses an image below its minimum, and crops one whose ratio it dislikes. Both need the real number, not a guess.",
  }),
  pair("height", "Height in pixels", { means: "As above." }),
  pair("byteSize", "Size in bytes", {
    means: "Meta has an upper limit. Discovering it at upload time means discovering it mid-creation.",
  }),
  pair("contentHash", "A hash of the exact bytes", {
    means: "What makes the asset immutable in fact rather than by convention: a replaced file produces a different hash, and the campaign that used the old one can say so.",
  }),
  pair("storageOrigin", "Where the bytes actually live", {
    means: "Named storage GRAV controls. Not a third-party URL that may stop resolving.",
  }),
  pair("readMechanism", "How the bytes are read", {
    means: "A real, callable way to get the binary. Meta uploads the image itself; a reference GRAV cannot dereference is not an asset.",
  }),
  pair("rightsState", "Recorded permission to advertise with it", {
    means: "Somebody has to have said this company may use this image in paid advertising. A campaign is a public, paid use.",
  }),
  pair("approvedPlanRevision", "The plan revision it was approved for", {
    means: "An image swapped after approval is a different advertisement, and the approval was of the old one.",
  }),
  pair("usable", "Whether it is usable right now", {
    means: "Withdrawn, expired or superseded assets exist. The question is asked at deployment time, not answered once at upload.",
  }),
  pair("providerUpload", "What the channel said when it was uploaded", {
    means: "Meta returns its own image hash. Recorded when that happens — never invented, because a fabricated hash is an advertisement showing a picture nobody chose.",
  }),
];
const IMAGE_ASSET_FIELDS = codes(IMAGE_ASSET_CONTRACT);

/* What a marketer is told. No mention of hashes or byte sizes: the honest
   summary of the situation is that GRAV has nowhere to keep advertising images
   yet, and somebody has to build that before this campaign can be created. */
const IMAGE_ASSET_BLOCKER = freeze({
  code: "ADVERTISING_IMAGE_NOT_AVAILABLE",
  label: "There is no advertising image GRAV can use",
  means: "GRAV's content library holds emails, forms and landing pages — it has nowhere to keep an advertising image yet. An image advertisement cannot be created without one, and GRAV will not send a picture it cannot verify the company owns.",
  whatWouldFixIt: "An advertising image library, where an image is uploaded once, checked, and recorded as approved for paid advertising.",
});

/* Things a plan might carry in the image slot, and the honest refusal for each.
   Internal reasons; the public message is the blocker above. */
const REFUSED_IMAGE_SOURCES = [
  pair("email_content", "An image from an email", {
    why: "It is a URL inside an email body that the marketing engine may rewrite, expire or track. Nothing guarantees it resolves tomorrow.",
  }),
  pair("arbitrary_url", "A web address", {
    why: "GRAV has never inspected it, does not control it, and cannot prove the company may advertise with it.",
  }),
  pair("attachment", "A file attached to something else", {
    why: "No dimensions, no hash, no rights state and no stable identifier to reconcile against.",
  }),
  pair("free_text", "A description of a picture", {
    why: "An instruction to a person, not an asset.",
  }),
  pair("landing_page_content", "A landing page or form reference", {
    why: "It is a page, not an image. The content library has no advertising media kind.",
  }),
];
const REFUSED_IMAGE_SOURCE_CODES = codes(REFUSED_IMAGE_SOURCES);

/* ═══════════════════════════════════════════════════════════════════════════
   TARGETING: WHAT NEEDS AN IDENTIFIER AND WHAT DOES NOT
   ───────────────────────────────────────────────────────────────────────────
   Meta's `targeting` object takes geo_locations by KEY — a country is `"IN"`,
   a region and a city are opaque keys from its own search endpoint — and
   locales by numeric id. Free text resolves to nothing, and Meta's search
   endpoint returns ranked suggestions, so taking the first is the same mistake
   the Google chunk refused.

   Age is different: `age_min` and `age_max` are plain integers inside Meta's
   own bounds, so they are VALIDATED rather than resolved. Saying so here is
   what stops somebody building a pointless lookup for them.
   ═══════════════════════════════════════════════════════════════════════════ */

const TARGETING_FIELDS = [
  pair("geo_included", "Locations the advertisement runs in", {
    needsResolution: true,
    providerField: "geo_locations",
    means: "Meta targets by its own location key, not by name.",
  }),
  pair("geo_excluded", "Locations it must not run in", {
    needsResolution: true,
    providerField: "excluded_geo_locations",
    means: "A separate field in Meta's targeting object. An exclusion sent as an inclusion runs the campaign in the one place somebody said to avoid.",
  }),
  pair("locales", "Languages", {
    needsResolution: true,
    providerField: "locales",
    means: "Meta targets by numeric locale id.",
  }),
  pair("age", "Age boundaries", {
    needsResolution: false,
    providerField: "age_min / age_max",
    means: "Plain integers within Meta's own bounds. Validated, not looked up.",
  }),
];
const TARGETING_FIELD_CODES = codes(TARGETING_FIELDS);

/* Meta's own bounds. A plan outside them is refused rather than clamped: a
   campaign silently widened to 18+ reaches people the plan excluded. */
const AGE_BOUNDS = freeze({ MIN: 13, MAX: 65, MAX_MEANS_AND_OVER: true });

/* ═══════════════════════════════════════════════════════════════════════════
   THE ONE AUDIENCE MODE
   ───────────────────────────────────────────────────────────────────────────
   `broad_prospecting` — deliberately broad, deliberately CONSTRAINED, and every
   constraint stated by a person.

   The distinction that matters, and the one this whole block exists to hold:
   "broad" must mean somebody decided to reach a wide audience within named
   boundaries. It must NOT mean GRAV left fields out and the channel filled them
   in. Those two produce identical-looking campaigns and very different bills —
   an omitted age range is 13-to-65 in most markets, an omitted gender is
   everyone, and an omitted location is wherever the channel decides.

   So every supported field is REQUIRED. There is no partial broad prospecting.
   ═══════════════════════════════════════════════════════════════════════════ */

const AUDIENCE_MODES = [
  pair("broad_prospecting", "Broad prospecting", {
    means: "Reach people who have not heard of the company, within locations, ages, genders and languages somebody chose explicitly.",
    supported: true,
    /* Each of these must be present and explicit. An absent one is refused, not
       defaulted — see the block comment above. */
    requires: freeze(["includedLocations", "excludedLocations", "ageMin", "ageMax", "genders", "languages"]),
  }),
];
const AUDIENCE_MODE_CODES = codes(AUDIENCE_MODES);
const SUPPORTED_AUDIENCE_MODE = "broad_prospecting";

/* ── GENDER, WITH AN EXPLICIT "EVERYONE" ────────────────────────────────────
   `all` is a CHOICE, not an absence, and that is the entire point of listing it.
   Meta's own default is everyone; if GRAV allowed the field to be omitted, a
   plan that had never considered gender and a plan that deliberately chose
   everyone would be stored identically and nobody could tell them apart later.

   Meta's API takes `genders: [1]` for men, `[2]` for women, and the field
   ABSENT for everyone — so "all" maps to omitting the key, which is exactly the
   case that has to be a recorded decision rather than a gap. */
const AUDIENCE_GENDERS = [
  pair("all", "Everyone", {
    provider: null,
    providerMeans: "The channel's targeting omits the gender field, which means everyone.",
    means: "A deliberate choice to reach everyone, not an unanswered question.",
  }),
  pair("men", "Men", { provider: freeze([1]) }),
  pair("women", "Women", { provider: freeze([2]) }),
];
const AUDIENCE_GENDER_CODES = codes(AUDIENCE_GENDERS);

/* ── WHAT `broad_prospecting` IS NOT ────────────────────────────────────────
   Every one of these is a real Meta capability and a real thing a marketer will
   ask for. Each is refused BY NAME internally so a log and a test can be
   precise, and with one sentence publicly.

   `advantage_audience_expansion` and `automated_expansion` deserve their own
   line: they are settings that let the channel show the advertisement to people
   OUTSIDE the audience somebody specified. A plan whose boundaries were
   reviewed and approved would quietly stop having boundaries. GRAV's mapper
   must set them off explicitly rather than omitting them. */
const REFUSED_AUDIENCE_FEATURES = [
  pair("custom_audience", "A custom audience", {
    why: "An account-level object built from data GRAV does not hold and cannot verify the company may use.",
  }),
  pair("lookalike", "A lookalike audience", {
    why: "Built from a custom audience GRAV does not hold.",
  }),
  pair("retargeting", "Retargeting", {
    why: "Reaching people who already visited needs an audience built from measurement data, which is a different campaign shape with its own consent questions.",
  }),
  pair("interest_targeting", "Interest targeting", {
    why: "The channel targets interests by taxonomy id, and GRAV has no lookup for them. A name typed into a plan is not an interest.",
  }),
  pair("behavioural_targeting", "Behavioural targeting", {
    why: "The channel's own taxonomy again, and the same problem.",
  }),
  pair("uploaded_customer_list", "An uploaded customer list", {
    why: "Uploading customer data to an advertising channel is a decision about people's personal information, not a targeting setting.",
  }),
  pair("advantage_audience_expansion", "Advantage audience expansion", {
    why: "It lets the channel show the advertisement to people outside the audience that was approved.",
  }),
  pair("automated_expansion", "Automated audience expansion", {
    why: "As above: the approved boundaries stop being boundaries.",
  }),
];
const REFUSED_AUDIENCE_FEATURE_CODES = codes(REFUSED_AUDIENCE_FEATURES);

/* The one sentence a marketer gets. Names none of the features above. */
const AUDIENCE_UNSUPPORTED_PUBLIC_MESSAGE =
  "GRAV supports one kind of audience for this channel: broad prospecting within locations, ages, genders and languages you choose. The audience on this plan asks for something else.";

/* ── AUDIENCES GRAV CANNOT EXPRESS ──────────────────────────────────────────
   The approved brief carries audience entries of several kinds. Interests and
   behaviours are Meta taxonomy items needing their own lookup; custom lists and
   lookalikes are account-level objects GRAV does not hold and cannot create.
   Each is refused by name rather than dropped — a dropped audience is a campaign
   shown to everybody. */
const AUDIENCE_KIND_SUPPORT = freeze({
  interest: freeze({ supported: false, why: "Meta targets interests by taxonomy id, and GRAV has no lookup for them." }),
  behaviour: freeze({ supported: false, why: "Meta targets behaviours by taxonomy id, and GRAV has no lookup for them." }),
  demographic: freeze({ supported: false, why: "Meta's demographic targeting is its own taxonomy, not free text." }),
  custom_list: freeze({ supported: false, why: "A custom audience is an account-level object GRAV does not hold." }),
  lookalike: freeze({ supported: false, why: "A lookalike audience is built from a custom audience GRAV does not hold." }),
  search_intent: freeze({ supported: false, why: "Search intent is a Google concept. Meta has no equivalent." }),
});

/* ═══════════════════════════════════════════════════════════════════════════
   SPECIAL AD CATEGORIES
   ───────────────────────────────────────────────────────────────────────────
   Meta requires every campaign to declare whether it advertises credit,
   employment, housing, social issues, elections or politics — because those
   categories are legally restricted and targeting is limited for them.

   There is a default (`NONE`), and using it silently is the single most
   consequential hidden default on this platform: a recruitment campaign
   declared as NONE is a policy violation and, in several jurisdictions, a legal
   one. So GRAV requires the plan to say, and refuses when it has not.
   ═══════════════════════════════════════════════════════════════════════════ */

const SPECIAL_AD_CATEGORIES = [
  pair("none", "None of these", { provider: "NONE" }),
  pair("credit", "Credit", { provider: "CREDIT", restricted: true }),
  pair("employment", "Employment", { provider: "EMPLOYMENT", restricted: true }),
  pair("housing", "Housing", { provider: "HOUSING", restricted: true }),
  pair("issues_elections_politics", "Social issues, elections or politics", {
    provider: "ISSUES_ELECTIONS_POLITICS", restricted: true,
  }),
];
const SPECIAL_AD_CATEGORY_CODES = codes(SPECIAL_AD_CATEGORIES);

/* ── CALLS TO ACTION META ACCEPTS FOR A TRAFFIC AD ──────────────────────────
   A closed table. The plan holds the marketer's words; anything not in here is
   refused rather than mapped to whatever looks closest, because a call to
   action is the promise the advertisement makes. */
const CALLS_TO_ACTION = [
  pair("learn_more", "Learn more", { provider: "LEARN_MORE" }),
  pair("shop_now", "Shop now", { provider: "SHOP_NOW" }),
  pair("sign_up", "Sign up", { provider: "SIGN_UP" }),
  pair("book_now", "Book now", { provider: "BOOK_NOW" }),
  pair("contact_us", "Contact us", { provider: "CONTACT_US" }),
  pair("get_quote", "Get a quote", { provider: "GET_QUOTE" }),
  pair("download", "Download", { provider: "DOWNLOAD" }),
  pair("see_menu", "See menu", { provider: "SEE_MENU" }),
];
const CALL_TO_ACTION_CODES = codes(CALLS_TO_ACTION);

/* Meta's own limits for a single-image traffic ad. Refused, never trimmed —
   the same rule the Google mapper follows, for the same reason. */
const META_LIMITS = freeze({
  PRIMARY_TEXT_MAX: 125,
  HEADLINE_MAX: 40,
  DESCRIPTION_MAX: 30,
  DESTINATION_URL_MAX: 2048,
  /* Meta's money unit is the account currency's minor unit — paise, cents. An
     integer, always: a fractional minor unit is an amount the platform rounds
     in a direction nobody chose. */
  MINOR_UNITS_PER_MAJOR: 100,
  /* Meta refuses a daily budget below roughly this in most currencies. Checked
     locally so the refusal can be GRAV's sentence rather than an opaque one. */
  MIN_DAILY_BUDGET_MINOR: 100,
  IMAGE_MIN_WIDTH: 600,
  IMAGE_MIN_HEIGHT: 600,
  IMAGE_MAX_BYTES: 30 * 1024 * 1024,
  IMAGE_MIME_TYPES: freeze(["image/jpeg", "image/png"]),
});

/* ── BUDGET PLACEMENT ───────────────────────────────────────────────────────
   Meta allows the budget on the campaign or on the ad set, and they behave
   differently. With one ad set the practical difference is small — but
   "campaign budget optimisation" means Meta may later redistribute across ad
   sets, and GRAV's MVP has exactly one, so declaring it there would enable a
   behaviour nobody asked for. The budget goes on the AD SET, and this says so
   rather than leaving it to whoever writes the mapper. */
const BUDGET_PLACEMENT = freeze({
  level: "ad_set",
  why: "One ad set, and the budget belongs to it. Putting it on the campaign switches on automated redistribution across ad sets, which GRAV's supported shape does not have and nobody asked for.",
  supportedBases: freeze(["daily", "total"]),
  providerField: freeze({ daily: "daily_budget", total: "lifetime_budget" }),
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE OBJECT GRAPH GRAV WOULD CREATE, LATER
   ───────────────────────────────────────────────────────────────────────────
   Nothing in this slice creates any of it. The roles are declared so the
   preflight can show a marketer what WOULD be made, and so the later creation
   slice inherits the same vocabulary the Google path uses.
   ═══════════════════════════════════════════════════════════════════════════ */

const META_OBJECTS = [
  pair("campaign", "Campaign", {
    providerNode: "campaign",
    /* Meta campaigns carry a status and it is what gates delivery. */
    deliveryStateApplies: true,
    stoppedStatus: "PAUSED",
    dependsOn: null,
  }),
  pair("audience_group", "Ad set", {
    providerNode: "adset",
    deliveryStateApplies: true,
    stoppedStatus: "PAUSED",
    dependsOn: "campaign",
  }),
  pair("creative", "Creative", {
    providerNode: "adcreative",
    /* ── A CREATIVE DOES NOT DELIVER BY ITSELF ───────────────────────────
       It is a reusable description of what an advertisement looks like. It has
       no status, nothing is shown because of it, and it cannot be paused. The
       same distinction the Google budget forced: asking it whether it is
       stopped has no true answer. */
    deliveryStateApplies: false,
    stoppedStatus: null,
    dependsOn: null,
  }),
  pair("advertisement", "Advertisement", {
    providerNode: "ad",
    deliveryStateApplies: true,
    stoppedStatus: "PAUSED",
    dependsOn: "audience_group",
  }),
];
const META_OBJECT_CODES = codes(META_OBJECTS);
const META_OBJECT_BY_CODE = freeze(Object.fromEntries(META_OBJECTS.map((o) => [o.code, o])));

/* The order a later slice would create them in. Declared here so the design
   record and the preflight agree, and so the creation slice cannot quietly
   reorder them. */
const CREATION_ORDER = freeze(["campaign", "audience_group", "creative", "advertisement"]);

/* ── WHAT THE PREFLIGHT ASKS ────────────────────────────────────────────────
   Every one is a READ. Nothing in this slice writes to Meta. */
const PREFLIGHT_CHECKS = [
  pair("account_reachable", "The advertising account answers", {
    means: "GRAV read the bound account through the advertising connection.",
    blocksCreation: true,
  }),
  pair("account_identity_confirmed", "It is the account that was bound", {
    means: "The account GRAV read back is the one somebody chose — not whichever account the connection happened to list first.",
    blocksCreation: true,
  }),
  pair("account_currency_matches", "The account's currency matches the plan", {
    means: "A budget approved in one currency cannot be created in an account that bills in another.",
    blocksCreation: true,
  }),
  pair("account_timezone_known", "The account's timezone is known", {
    means: "A campaign's start and end times are that account's times.",
    blocksCreation: true,
  }),
  pair("account_usable", "The account is active and not restricted", {
    means: "A disabled, unsettled or restricted account accepts nothing.",
    blocksCreation: true,
  }),
  pair("business_context_confirmed", "The account sits in the expected business", {
    means: "Where the channel exposes it. An account in somebody else's business is somebody else's account.",
    blocksCreation: false,
  }),
  pair("campaign_reads_available", "GRAV can read campaigns, ad sets and advertisements", {
    means: "A connection that can create but not read back cannot prove anything it made is stopped.",
    blocksCreation: true,
  }),
  pair("insights_available", "GRAV can read delivery figures", {
    means: "Needed to report on the campaign afterwards, not to create it.",
    blocksCreation: false,
  }),
  pair("tracking_identity_readable", "The configured Pixel can be read", {
    means: "A pixel id that the account cannot see measures nothing, and an optimisation aimed at landing-page views would have nothing to aim at.",
    blocksCreation: false,
  }),
  pair("destination_usable", "The destination can be advertised to", {
    means: "Where the channel exposes it. A domain the business has not verified may be refused at creation.",
    blocksCreation: false,
  }),
  pair("advertising_image_available", "There is an advertising image", {
    means: "GRAV has nowhere to keep one yet. This is the blocker that stops every Meta campaign today.",
    blocksCreation: true,
  }),
];
const PREFLIGHT_CHECK_CODES = codes(PREFLIGHT_CHECKS);

/* ── TWO FLAGS THAT ARE ALWAYS FALSE IN THIS SLICE ──────────────────────────
   Frozen constants rather than computed values, so no combination of inputs can
   make either true. */
const ACTIVATION_NOT_IN_THIS_SLICE = freeze({
  activationReady: false,
  reasonCode: "ACTIVATION_NOT_BUILT",
  means: "GRAV cannot start a Meta campaign. It cannot create one yet either. Activation is a separate decision with its own authority, and it has not been built.",
});

const DEPLOYMENT_NOT_IN_THIS_SLICE = freeze({
  deploymentReady: false,
  reasonCode: "META_CREATION_NOT_BUILT",
  means: "Nothing has been created in Meta and nothing can be. This slice checks and explains; the step that would create a stopped campaign has not been built.",
});

/* GRAV's own refusal codes for this channel. A Meta error code, message or field
   path never reaches a caller. */
const META_CODES = freeze({
  CAMPAIGN_TYPE_UNSUPPORTED: "CAMPAIGN_TYPE_UNSUPPORTED",
  BRIEF_MISSING: "BRIEF_MISSING",
  OBJECTIVE_UNSUPPORTED: "OBJECTIVE_UNSUPPORTED",
  OPTIMISATION_MISSING: "OPTIMISATION_MISSING",
  OPTIMISATION_UNSUPPORTED: "OPTIMISATION_UNSUPPORTED",
  OPTIMISATION_NEEDS_TRACKING: "OPTIMISATION_NEEDS_TRACKING",
  SPECIAL_AD_CATEGORY_MISSING: "SPECIAL_AD_CATEGORY_MISSING",
  SPECIAL_AD_CATEGORY_UNSUPPORTED: "SPECIAL_AD_CATEGORY_UNSUPPORTED",
  PRIMARY_TEXT_MISSING: "PRIMARY_TEXT_MISSING",
  PRIMARY_TEXT_TOO_LONG: "PRIMARY_TEXT_TOO_LONG",
  HEADLINE_MISSING: "HEADLINE_MISSING",
  HEADLINE_TOO_LONG: "HEADLINE_TOO_LONG",
  CALL_TO_ACTION_MISSING: "CALL_TO_ACTION_MISSING",
  CALL_TO_ACTION_UNSUPPORTED: "CALL_TO_ACTION_UNSUPPORTED",
  DESTINATION_UNRESOLVED: "DESTINATION_UNRESOLVED",
  DESTINATION_TOO_LONG: "DESTINATION_TOO_LONG",
  IMAGE_ASSET_MISSING: "IMAGE_ASSET_MISSING",
  IMAGE_SOURCE_REFUSED: "IMAGE_SOURCE_REFUSED",
  BUDGET_MISSING: "BUDGET_MISSING",
  BUDGET_BASIS_UNSUPPORTED: "BUDGET_BASIS_UNSUPPORTED",
  BUDGET_NOT_WHOLE_MINOR_UNITS: "BUDGET_NOT_WHOLE_MINOR_UNITS",
  BUDGET_BELOW_PROVIDER_MINIMUM: "BUDGET_BELOW_PROVIDER_MINIMUM",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  SCHEDULE_MISSING: "SCHEDULE_MISSING",
  TIMEZONE_MISSING: "TIMEZONE_MISSING",
  TIMEZONE_MISMATCH: "TIMEZONE_MISMATCH",
  AGE_OUT_OF_BOUNDS: "AGE_OUT_OF_BOUNDS",
  AGE_REVERSED: "AGE_REVERSED",
  AUDIENCE_UNSUPPORTED: "AUDIENCE_UNSUPPORTED",
  AUDIENCE_MODE_MISSING: "AUDIENCE_MODE_MISSING",
  AUDIENCE_MODE_UNSUPPORTED: "AUDIENCE_MODE_UNSUPPORTED",
  AUDIENCE_FIELD_MISSING: "AUDIENCE_FIELD_MISSING",
  GENDER_MISSING: "GENDER_MISSING",
  GENDER_UNSUPPORTED: "GENDER_UNSUPPORTED",
  AUDIENCE_EXPANSION_REFUSED: "AUDIENCE_EXPANSION_REFUSED",
  GEO_NONE_SELECTED: "GEO_NONE_SELECTED",
  GEO_INCLUDED_AND_EXCLUDED: "GEO_INCLUDED_AND_EXCLUDED",
  TARGETING_NOT_RESOLVED: "TARGETING_NOT_RESOLVED",
  TARGETING_STALE: "TARGETING_STALE",
  TRACKING_IDENTITY_MISSING: "TRACKING_IDENTITY_MISSING",
  NAME_TOO_LONG: "NAME_TOO_LONG",
});

module.exports = freeze({
  CHANNEL,
  CAMPAIGN_TYPE,
  MVP_CONTRACT,
  UNSUPPORTED_SHAPES,
  UNSUPPORTED_SHAPE_CODES,
  UNSUPPORTED_PUBLIC_MESSAGE,

  IMAGE_ASSET_CONTRACT,
  IMAGE_ASSET_FIELDS,
  IMAGE_ASSET_BLOCKER,
  REFUSED_IMAGE_SOURCES,
  REFUSED_IMAGE_SOURCE_CODES,

  AUDIENCE_MODES,
  AUDIENCE_MODE_CODES,
  SUPPORTED_AUDIENCE_MODE,
  AUDIENCE_GENDERS,
  AUDIENCE_GENDER_CODES,
  REFUSED_AUDIENCE_FEATURES,
  REFUSED_AUDIENCE_FEATURE_CODES,
  AUDIENCE_UNSUPPORTED_PUBLIC_MESSAGE,

  TARGETING_FIELDS,
  TARGETING_FIELD_CODES,
  AGE_BOUNDS,
  AUDIENCE_KIND_SUPPORT,

  SPECIAL_AD_CATEGORIES,
  SPECIAL_AD_CATEGORY_CODES,
  CALLS_TO_ACTION,
  CALL_TO_ACTION_CODES,
  META_LIMITS,
  BUDGET_PLACEMENT,

  META_OBJECTS,
  META_OBJECT_CODES,
  META_OBJECT_BY_CODE,
  CREATION_ORDER,

  PREFLIGHT_CHECKS,
  PREFLIGHT_CHECK_CODES,
  ACTIVATION_NOT_IN_THIS_SLICE,
  DEPLOYMENT_NOT_IN_THIS_SLICE,
  META_CODES,
});
