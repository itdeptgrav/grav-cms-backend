// constants/marketingGoogleSearchDeployment.js
//
// THE VOCABULARY OF THE FIRST REAL ADVERTISING WRITE.
//
// Two separate things live here, and they are separate on purpose:
//
//   1. ACCOUNT BINDING — which advertising account a GRAV company deploys into.
//      A binding is an account identifier and a decision by a named person. It
//      is NOT a credential, and nothing in this file or the record it describes
//      can hold one.
//
//   2. GOOGLE SEARCH MAPPING — the provider's own limits, enums and object
//      shapes, named once so the mapper can refuse a plan that will not fit
//      rather than trimming it to fit.
//
// ── WHY GOOGLE'S LIMITS ARE WRITTEN DOWN HERE AND NOT DISCOVERED ───────────
// A responsive search ad allows 30 characters in a headline and 90 in a
// description. GRAV's own plan allows 120 and 2000, because a plan is written
// before anybody picks a channel. The gap is real, and there are exactly two
// ways to handle it: truncate, or refuse.
//
// Truncation is refused. "Summer collection — free delivery over" is not the
// headline anybody approved, it is money spent on a sentence that stops mid-
// word, and nobody sees it until it is live. So the limits sit here, the mapper
// checks them, and a plan that exceeds one is reported field by field with the
// actual length against the allowance.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ═══════════════════════════════════════════════════════════════════════════
   ACCOUNT BINDING
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── WHY A BINDING EXISTS AT ALL ────────────────────────────────────────────
   The read chunk takes its account from `GOOGLE_ADS_CUSTOMER_ID`, a deployment
   secret. For reads that is tolerable: the worst case is reading a report for
   the wrong account.

   For writes it is not. A credential that can see three accounts — an agency's
   own, a client's, a test one — would create a real campaign in whichever one
   the environment happened to name, and nobody chose that. So a write needs a
   binding: a deliberate act by a named person recording WHICH account this
   company's campaigns are created in, verified against the accounts the
   credential can actually see at the moment it was made. */
const BINDING_STATES = [
  pair("unverified", "Not yet verified", {
    means: "Somebody recorded an account. GRAV has not yet confirmed the connection can reach it.",
    mayDeploy: false,
  }),
  pair("verified", "Verified", {
    means: "GRAV read this account through the advertising connection and the person who bound it confirmed it.",
    mayDeploy: true,
  }),
  pair("unreachable", "Cannot be reached", {
    means: "GRAV could not read this account through the advertising connection the last time it tried.",
    mayDeploy: false,
  }),
  pair("revoked", "Withdrawn", {
    means: "Somebody withdrew this binding. Nothing new can be created in this account until it is bound again.",
    mayDeploy: false,
  }),
];
const BINDING_STATE_CODES = codes(BINDING_STATES);
const BINDING_STATES_ALLOWING_DEPLOYMENT = freeze(
  BINDING_STATES.filter((s) => s.mayDeploy).map((s) => s.code),
);

/* ── WHAT MAY BE STORED ON A BINDING, EXHAUSTIVELY ──────────────────────────
   An allow-list rather than a deny-list. A deny-list of secret-shaped names is
   a guess about what a future credential is called; this says what a binding IS,
   and the write boundary refuses everything else by name.

   Every one of these is an identifier or a label that the advertising interface
   itself shows to anybody who can open the account. None is a capability. */
const BINDING_FIELDS = freeze([
  "channel",
  "externalAccountId",
  "externalAccountName",
  "loginAccountId",
  /* The business an account sits in, where the channel has such a concept. An
     identifier on every screen of the advertising interface, not a capability. */
  "businessId",
  "currency",
  "timeZone",
  "note",
]);

/* ── AND WHICH OF THOSE EACH CHANNEL'S CALLER MAY SUPPLY ────────────────────
   `BINDING_FIELDS` above says what a binding RECORD may hold — including the
   currency and time zone that come back from the account probe, which no caller
   sends. This says what a CALLER may send, per channel, and it is deliberately
   narrower.

   ── WHY PER CHANNEL, AND NOT ONE COMBINED LIST ────────────────────────────
   Google's second identifier is a manager account; Meta's is the business the
   account sits in. They are different objects with different meanings, and a
   combined list lets each channel silently accept the other's.

   That is not a tidiness point. Accepting a Meta business id on a Google
   binding stores a number that no Google preflight will ever read, so the
   binding looks complete and is not — and the way somebody finds out is a
   campaign created against a manager account they never chose. Refusing it by
   name says which field belongs to which channel, at the moment somebody gets
   it wrong.

   `businessId` is OPTIONAL on Meta, matching the existing service contract: a
   personal advertising account legitimately belongs to no business, and Meta
   preflight already reports an absent business as `not_applicable` rather than
   failing. Making it required here would refuse bindings that deploy correctly
   today. */
const CHANNEL_BINDING_FIELDS = freeze({
  google_ads: freeze({
    required: freeze(["externalAccountId"]),
    optional: freeze(["loginAccountId", "externalAccountName", "note"]),
    secondary: "loginAccountId",
    secondaryMeans: "the manager account the advertising account sits under",
  }),
  meta_ads: freeze({
    required: freeze(["externalAccountId"]),
    optional: freeze(["businessId", "externalAccountName", "note"]),
    secondary: "businessId",
    secondaryMeans: "the business the advertising account sits in",
  }),
});

const callerFieldsFor = (channel) => {
  const spec = CHANNEL_BINDING_FIELDS[channel];
  return spec ? [...spec.required, ...spec.optional] : [];
};

/* Which OTHER channel a field belongs to, or "". Shared by the route and the
   service so both refuse a misplaced identifier with the same sentence — the
   route refuses first, and a refusal that only says "not part of it" invites
   somebody to conclude GRAV cannot record a business at all.

   A field this channel accepts is never foreign, however many other channels
   also accept it: `externalAccountId` is on every channel, and reporting it as
   "belongs to meta ads" on a Google binding would be nonsense. */
const foreignFieldOwner = (field, channel) => {
  if (callerFieldsFor(channel).includes(field)) return "";
  return Object.keys(CHANNEL_BINDING_FIELDS)
    .find((c) => c !== channel && callerFieldsFor(c).includes(field)) || "";
};

const readableChannel = (channel) => String(channel || "").replace(/_/g, " ");

/* The one sentence both layers use. */
const misplacedFieldMessage = (field, channel) => {
  const owner = foreignFieldOwner(field, channel);
  const allowed = callerFieldsFor(channel);
  return owner
    ? `${field} belongs to ${readableChannel(owner)}, not ${readableChannel(channel)}. `
      + `A ${readableChannel(channel)} account binding records: ${allowed.join(", ")}.`
    : `A ${readableChannel(channel)} account binding records only: ${allowed.join(", ")}.`;
};

/* ── AND WHAT MAY NEVER BE ──────────────────────────────────────────────────
   Belt and braces over the allow-list, so the refusal names the actual problem
   ("that is a credential") instead of the generic one ("unknown field"). A
   person pasting a developer token into a "note" deserves to be told why it was
   refused, and a log line that says `unknown field: developerToken` invites them
   to try `developer_token`. */
const BINDING_FORBIDDEN_HINTS = freeze([
  "token", "secret", "password", "credential", "refresh", "clientsecret",
  "developertoken", "accesstoken", "apikey", "privatekey", "bearer",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   GOOGLE SEARCH: WHAT THE PROVIDER ACTUALLY ACCEPTS
   ═══════════════════════════════════════════════════════════════════════════ */

/* Google Ads API resource limits for a Search campaign with one responsive
   search ad. Exceeding any of these is a refusal at mapping time, before a
   single external call. */
const GOOGLE_SEARCH_LIMITS = freeze({
  CAMPAIGN_NAME_MAX: 255,

  HEADLINE_MAX_CHARS: 30,
  DESCRIPTION_MAX_CHARS: 90,

  /* Google will not create a responsive search ad with fewer than three
     headlines or two descriptions, and accepts no more than fifteen and four. */
  HEADLINES_MIN: 3,
  HEADLINES_MAX: 15,
  DESCRIPTIONS_MIN: 2,
  DESCRIPTIONS_MAX: 4,

  /* A keyword's text. GRAV's plan allows 120 characters for a theme. */
  KEYWORD_MAX_CHARS: 80,
  KEYWORD_MAX_WORDS: 10,
  KEYWORDS_MIN: 1,
  KEYWORDS_MAX: 200,

  FINAL_URL_MAX: 2048,

  /* Google's money unit. Every amount crossing the boundary is an integer
     number of these, never a float — see `toMicros`. */
  MICROS_PER_UNIT: 1_000_000,
  /* Google rejects a daily budget below this, and the refusal it sends is not
     self-explanatory. Checked locally so the message can be. */
  MIN_DAILY_BUDGET_MICROS: 10_000,
});

/* ── THE OBJECTS ONE PAUSED CAMPAIGN IS MADE OF ─────────────────────────────
   In creation order, which is also dependency order: a campaign cannot be
   created without a budget resource name, an ad group without a campaign, an ad
   without an ad group.

   The codes are GRAV's, not Google's: an `audience_group` is a Google ad group
   and a Meta ad set, and naming it after either would put one provider's word in
   every record and every route. The Google resource each maps to is the
   `resource` beside it, and it is named in exactly one place — the write
   client's table — so nothing outside that file can reach an endpoint.

   `deliveryStateApplies` is the answer to the question the attempt record asks
   of every object, and it is answered HERE, from what the object is, rather
   than by whatever the orchestrator happened to observe. A campaign budget has
   no status that says whether anything is being shown; a campaign, an ad group
   and an ad each do. */
const GOOGLE_SEARCH_OBJECTS = [
  pair("budget", "Campaign budget", {
    resource: "campaignBudgets",
    /* A shared money object. It cannot be paused, and it cannot deliver. */
    deliveryStateApplies: false,
    /* ── AND IT CANNOT BE DELETED ONCE A CAMPAIGN USES IT ─────────────────
       Which is why it is created first and removed last, and why a rollback
       that cannot remove it says so rather than claiming a clean account. */
    removable: true,
  }),
  pair("campaign", "Campaign", {
    resource: "campaigns",
    deliveryStateApplies: true,
    removable: true,
  }),
  pair("audience_group", "Ad group", {
    resource: "adGroups",
    deliveryStateApplies: true,
    removable: true,
  }),
  pair("advertisement", "Ad", {
    resource: "adGroupAds",
    deliveryStateApplies: true,
    removable: true,
  }),
  pair("targeting_term", "Keyword", {
    resource: "adGroupCriteria",
    deliveryStateApplies: true,
    removable: true,
  }),

  /* ── TARGETING, WHICH HAS NO DELIVERY STATE OF ITS OWN ───────────────────
     A campaign criterion is not paused or running. It is a rule attached to a
     campaign, and the campaign's status decides whether anything is shown. The
     field that matters on it is `negative`: whether the place is targeted or
     avoided. Assigning it a delivery state would be the budget mistake again —
     an answer to a question it has not got. */
  pair("location_target", "Location", {
    resource: "campaignCriteria",
    deliveryStateApplies: false,
    removable: true,
  }),
  pair("language_target", "Language", {
    resource: "campaignCriteria",
    deliveryStateApplies: false,
    removable: true,
  }),
];
const GOOGLE_SEARCH_OBJECT_CODES = codes(GOOGLE_SEARCH_OBJECTS);
const GOOGLE_SEARCH_OBJECT_BY_CODE = freeze(
  Object.fromEntries(GOOGLE_SEARCH_OBJECTS.map((o) => [o.code, o])),
);

/* ── THE ONLY STATUS ANY CREATED OBJECT MAY CARRY ───────────────────────────
   One constant, referenced by the mapper and asserted by the write client.
   Google's `ENABLED` is not in this file at all: a value that is never written
   cannot be written by a typo, and a reviewer can check the absence by reading
   rather than by tracing. */
const NON_DELIVERING_STATUS = "PAUSED";

/* Google's own word for a Search campaign's advertising channel type. */
const SEARCH_CHANNEL_TYPE = "SEARCH";

/* ── KEYWORD MATCH TYPE ─────────────────────────────────────────────────────
   GRAV's plan records "keyword themes" in the author's words and deliberately
   holds no match type, because a match type is a Google concept. One is still
   required by the API, so the mapper uses PHRASE for every keyword and says so
   in the mapping it returns.

   PHRASE rather than BROAD: broad match spends on searches the author never
   wrote, which is the opposite of what "these are the terms I want" means.
   PHRASE rather than EXACT: exact would match almost nothing and make the
   campaign look broken. This is a documented GRAV decision, surfaced in the
   preflight so nobody discovers it from a Google screen. */
const KEYWORD_MATCH_TYPE = "PHRASE";

/* ── BIDDING, GRAV'S WORD TO GOOGLE'S ───────────────────────────────────────
   A closed table. A strategy absent from it is refused by name rather than
   mapped to whatever Google would otherwise default to — the provider's default
   decides how money is spent, and "whatever the channel does" is not a decision
   anybody made. */
const BIDDING_TO_GOOGLE = freeze({
  maximise_clicks: freeze({
    field: "targetSpend",
    payload: freeze({}),
    needsTarget: false,
    means: "Google spends the budget to get as many clicks as it can.",
  }),
  target_cost_per_click: freeze({
    field: "manualCpc",
    /* Manual CPC with enhanced bidding off: an enhanced setting lets Google
       exceed the target, which is not what "target cost per click" was
       approved as. */
    payload: freeze({ enhancedCpcEnabled: false }),
    needsTarget: true,
    targetField: "cpcBidMicros",
    /* The target is an ad-group-level bid in Google's model, not a campaign
       one. Named here so the mapper puts it where it belongs. */
    targetLevel: "ad_group",
    means: "Google bids up to the approved amount for each click.",
  }),
  target_cost_per_action: freeze({
    field: "targetCpa",
    needsTarget: true,
    targetField: "targetCpaMicros",
    targetLevel: "campaign",
    /* ── AND IT NEEDS CONVERSION TRACKING GOOGLE CAN SEE ──────────────────
       An account with no conversion action cannot run this strategy, and
       Google's refusal arrives as an opaque field error. The preflight checks
       for a conversion action, and this flag is what tells it to. */
    needsConversionAction: true,
    means: "Google bids to reach the approved average cost per conversion.",
  }),
});

/* ── BUDGET RELATIONSHIP, GRAV'S WORD TO GOOGLE'S ───────────────────────────
   Google attaches a budget to a campaign and its period is either DAILY or
   TOTAL. `ad_set_daily` is Meta's model and has no Google meaning, so it is
   absent rather than mapped — a plan carrying it is refused by name. */
const BUDGET_RELATIONSHIP_TO_GOOGLE = freeze({
  campaign_daily: freeze({ deliveryMethod: "STANDARD", period: "DAILY" }),
  campaign_total: freeze({ deliveryMethod: "STANDARD", period: "CUSTOM_PERIOD" }),
});

/* ═══════════════════════════════════════════════════════════════════════════
   TARGETING RESOLUTION
   ───────────────────────────────────────────────────────────────────────────
   GRAV's plan holds the words somebody typed — "India", "Mumbai", "en". Google
   targets by numeric criterion id. Turning one into the other is a LOOKUP, and
   every lookup has five possible answers, not two.

   The earlier version had two: applied, or silently not applied. A campaign was
   created with no location criteria at all and a note explaining it, which in
   Google means EVERYWHERE. Stopped, so nothing was spent — until somebody opened
   Google Ads and pressed enable, at which point a campaign nobody had targeted
   started buying clicks worldwide. A disclosure does not contain that; only a
   refusal does.
   ═══════════════════════════════════════════════════════════════════════════ */

const TARGETING_OUTCOMES = [
  pair("resolved", "Resolved", {
    means: "Exactly one advertising target matched this name, and GRAV has its identifier.",
    blocksCreation: false,
  }),
  pair("ambiguous", "More than one match", {
    means: "Several advertising targets carry this name. Somebody has to say which one was meant.",
    blocksCreation: true,
  }),
  pair("not_found", "No match", {
    means: "No advertising target carries this name. It may be spelled differently in the channel.",
    blocksCreation: true,
  }),
  pair("unsupported", "Not supported", {
    means: "GRAV cannot express this kind of target in this channel yet.",
    blocksCreation: true,
  }),
  pair("provider_unavailable", "Could not be checked", {
    means: "The advertising channel did not answer. This is not a wrong name — nothing could be looked up.",
    blocksCreation: true,
  }),
];
const TARGETING_OUTCOME_CODES = codes(TARGETING_OUTCOMES);
const TARGETING_BLOCKING_OUTCOMES = freeze(
  TARGETING_OUTCOMES.filter((o) => o.blocksCreation).map((o) => o.code),
);

/* ── GRAV'S KIND OF PLACE → GOOGLE'S OWN TARGET TYPES ───────────────────────
   A closed table, and the values are Google's strings for `target_type`. Listed
   as a SET per GRAV kind because Google splits what GRAV calls a region across
   several words depending on the country — a state in India, a province in
   Canada, a governorate in Egypt. Narrowing the query by these is what turns
   "a city called Cork and a county called Cork" from an ambiguity into a match.

   `radius` is absent on purpose. Proximity targeting is a different criterion
   with a centre point and a distance, GRAV's plan holds neither, and a radius
   silently mapped to the city at its centre is a campaign covering a different
   area than the one somebody drew. */
const GEO_KIND_TO_TARGET_TYPES = freeze({
  country: freeze(["Country"]),
  region: freeze([
    "Region", "State", "Province", "Territory", "Governorate", "Prefecture",
    "Canton", "Okrug", "Autonomous Community", "Department", "Union Territory",
  ]),
  city: freeze(["City", "Municipality", "Borough", "District"]),
  postal_area: freeze(["Postal Code"]),
});
const UNSUPPORTED_GEO_KINDS = freeze(["radius"]);

/* ── WHY A REFUSAL HAPPENED, IN GRAV'S OWN CODES ────────────────────────────
   Every one of these is GRAV's. A Google error code, message or field path
   never reaches a caller; the mapping from one to the other lives in the write
   client and goes to the server log. */
const MAPPING_CODES = freeze({
  CAMPAIGN_TYPE_NOT_GOOGLE_SEARCH: "CAMPAIGN_TYPE_NOT_GOOGLE_SEARCH",
  BRIEF_MISSING: "BRIEF_MISSING",
  HEADLINE_TOO_LONG: "HEADLINE_TOO_LONG",
  HEADLINE_COUNT: "HEADLINE_COUNT",
  DESCRIPTION_TOO_LONG: "DESCRIPTION_TOO_LONG",
  DESCRIPTION_COUNT: "DESCRIPTION_COUNT",
  KEYWORD_TOO_LONG: "KEYWORD_TOO_LONG",
  KEYWORD_TOO_MANY_WORDS: "KEYWORD_TOO_MANY_WORDS",
  KEYWORD_COUNT: "KEYWORD_COUNT",
  BIDDING_UNSUPPORTED: "BIDDING_UNSUPPORTED",
  BIDDING_TARGET_MISSING: "BIDDING_TARGET_MISSING",
  BIDDING_TARGET_CURRENCY: "BIDDING_TARGET_CURRENCY",
  BUDGET_MISSING: "BUDGET_MISSING",
  BUDGET_RELATIONSHIP_UNSUPPORTED: "BUDGET_RELATIONSHIP_UNSUPPORTED",
  BUDGET_BELOW_PROVIDER_MINIMUM: "BUDGET_BELOW_PROVIDER_MINIMUM",
  BUDGET_NOT_WHOLE_MICROS: "BUDGET_NOT_WHOLE_MICROS",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  DESTINATION_UNRESOLVED: "DESTINATION_UNRESOLVED",
  DESTINATION_TOO_LONG: "DESTINATION_TOO_LONG",
  GEO_UNRESOLVED: "GEO_UNRESOLVED",
  GEO_NONE_SELECTED: "GEO_NONE_SELECTED",
  GEO_INCLUDED_AND_EXCLUDED: "GEO_INCLUDED_AND_EXCLUDED",
  LANGUAGE_UNRESOLVED: "LANGUAGE_UNRESOLVED",
  LANGUAGE_NONE_SELECTED: "LANGUAGE_NONE_SELECTED",
  TARGETING_NOT_RESOLVED: "TARGETING_NOT_RESOLVED",
  TARGETING_STALE: "TARGETING_STALE",
  SCHEDULE_MISSING: "SCHEDULE_MISSING",
  TIMEZONE_MISSING: "TIMEZONE_MISSING",
  TIMEZONE_MISMATCH: "TIMEZONE_MISMATCH",
  NAME_TOO_LONG: "NAME_TOO_LONG",
  UTM_MISSING: "UTM_MISSING",
  EU_POLITICAL_DECLARATION_MISSING: "EU_POLITICAL_DECLARATION_MISSING",
});

/* ── THE EU POLITICAL-ADVERTISING SELF-DECLARATION ──────────────────────────
   Google v25: "All new campaigns created through the Google Ads API should set
   the contains_eu_political_advertising field", and a create without it fails
   with FieldError.REQUIRED — including through GoogleAdsService.Mutate.

   It is a statement the ADVERTISER makes, with legal weight. GRAV will not make
   it on anybody's behalf, exactly as it will not choose Meta's special ad
   category: an empty value blocks deployment rather than defaulting. The plan
   records GRAV's word; this table is the only translation to Google's. */
const EU_POLITICAL_DECLARATION_TO_GOOGLE = freeze({
  does_not_contain: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
  contains: "CONTAINS_EU_POLITICAL_ADVERTISING",
});

/* ── WHAT THE PREFLIGHT ASKS THE ACCOUNT ────────────────────────────────────
   Each is a read. None of them writes, and the preflight is the only caller.

   `blocksCreation` is the honest split: an account GRAV cannot read cannot be
   created in, so that blocks. A missing conversion action blocks only when the
   chosen bidding strategy needs one. */
const PREFLIGHT_CHECKS = [
  pair("account_reachable", "The advertising account answers", {
    means: "GRAV read the bound account through the advertising connection.",
    blocksCreation: true,
  }),
  pair("account_currency_matches", "The account's currency matches the plan", {
    means: "A budget approved in one currency cannot be created in an account that bills in another.",
    blocksCreation: true,
  }),
  pair("account_timezone_known", "The account's timezone is known", {
    means: "A campaign's start and end days are that account's days.",
    blocksCreation: true,
  }),
  pair("account_not_manager", "The account can hold campaigns", {
    means: "A manager account holds other accounts, not campaigns.",
    blocksCreation: true,
  }),
  pair("account_usable", "The account is not suspended or closed", {
    means: "A cancelled or suspended account accepts nothing.",
    blocksCreation: true,
  }),
  pair("conversion_action_present", "The account can measure conversions", {
    means: "Only needed by a bidding strategy that aims at a cost per conversion.",
    blocksCreation: false,
  }),
  pair("targeting_resolvable", "Every location and language can be targeted", {
    means: "Google targets by identifier, not by name. Every place and language in the plan has to resolve to exactly one before anything is created, or the campaign would be created without it — which in Google means everywhere.",
    blocksCreation: true,
  }),
  pair("name_not_already_used", "No campaign of this name exists already", {
    means: "A second campaign with the same name is how a duplicate is created without anybody noticing.",
    blocksCreation: true,
  }),
];
const PREFLIGHT_CHECK_CODES = codes(PREFLIGHT_CHECKS);

/* ═══════════════════════════════════════════════════════════════════════════
   RECONCILIATION AFTER A LOST RESPONSE
   ───────────────────────────────────────────────────────────────────────────
   GRAV sent one atomic request and never learned the outcome. Something may
   exist in the advertising account. Five answers, and only ONE of them lets a
   machine close the attempt — the rest are for a person.
   ═══════════════════════════════════════════════════════════════════════════ */

const RECONCILIATION_OUTCOMES = [
  pair("not_found_unconfirmed", "Nothing found yet", {
    means: "GRAV found nothing carrying this deployment's marker. That is not proof the request failed: a channel's reads can lag its writes, so this stays unresolved rather than authorising a second attempt.",
    settles: false,
    needsAdministrator: false,
  }),
  pair("one_complete_bundle", "Found, complete and stopped", {
    means: "Exactly one campaign carries this deployment's marker, and every object, every stopped state and every location and language matches what was approved.",
    settles: true,
    needsAdministrator: false,
  }),
  pair("one_incomplete_or_mismatched_bundle", "Found, but not what was approved", {
    means: "One campaign carries this marker and it does not match the approved command — something is missing, something is able to deliver, or its targeting is not what was approved.",
    settles: false,
    needsAdministrator: true,
  }),
  pair("multiple_matches", "More than one match", {
    means: "Several campaigns carry this deployment's marker. GRAV will not choose between them.",
    settles: false,
    needsAdministrator: true,
  }),
  pair("provider_unavailable", "Could not be checked", {
    means: "The advertising channel did not answer, so nothing could be looked up. This is not an empty account.",
    settles: false,
    needsAdministrator: false,
  }),
];
const RECONCILIATION_OUTCOME_CODES = codes(RECONCILIATION_OUTCOMES);
const RECONCILIATION_SETTLING_OUTCOME = "one_complete_bundle";

/* ── EVERY OBJECT A COMPLETE BUNDLE HAS TO HAVE ─────────────────────────────
   Counted off the read-back, not assumed from the create response. A bundle
   missing any one of these is `one_incomplete_or_mismatched_bundle`, which
   needs a person — not a retry. */
const BUNDLE_REQUIREMENTS = freeze({
  campaigns: 1,
  labels: 1,
  budgets: 1,
  adGroups: 1,
  ads: 1,
});

/* ── WHY `activationReady` IS A FIELD AND NOT AN ABSENCE ────────────────────
   A caller that sees `creationReady: true` and no other flag will assume the
   campaign is ready to run. It is not, and it cannot be made to run by anything
   in this chunk. So the field is present, always false, and carries its own
   sentence saying what would have to happen first. */
const ACTIVATION_NOT_IN_THIS_CHUNK = freeze({
  activationReady: false,
  reasonCode: "ACTIVATION_NOT_BUILT",
  means: "GRAV can create this campaign in a paused state. Nothing in GRAV can start it delivering: activation is a separate decision with its own authority and its own spend ceiling, and it has not been built.",
});

module.exports = freeze({
  BINDING_STATES,
  BINDING_STATE_CODES,
  BINDING_STATES_ALLOWING_DEPLOYMENT,
  BINDING_FIELDS,
  CHANNEL_BINDING_FIELDS,
  callerFieldsFor,
  foreignFieldOwner,
  misplacedFieldMessage,
  BINDING_FORBIDDEN_HINTS,

  RECONCILIATION_OUTCOMES,
  RECONCILIATION_OUTCOME_CODES,
  RECONCILIATION_SETTLING_OUTCOME,
  BUNDLE_REQUIREMENTS,

  TARGETING_OUTCOMES,
  TARGETING_OUTCOME_CODES,
  TARGETING_BLOCKING_OUTCOMES,
  GEO_KIND_TO_TARGET_TYPES,
  UNSUPPORTED_GEO_KINDS,

  GOOGLE_SEARCH_LIMITS,
  GOOGLE_SEARCH_OBJECTS,
  GOOGLE_SEARCH_OBJECT_CODES,
  GOOGLE_SEARCH_OBJECT_BY_CODE,
  NON_DELIVERING_STATUS,
  SEARCH_CHANNEL_TYPE,
  KEYWORD_MATCH_TYPE,
  BIDDING_TO_GOOGLE,
  BUDGET_RELATIONSHIP_TO_GOOGLE,
  EU_POLITICAL_DECLARATION_TO_GOOGLE,
  MAPPING_CODES,

  PREFLIGHT_CHECKS,
  PREFLIGHT_CHECK_CODES,
  ACTIVATION_NOT_IN_THIS_CHUNK,
});
