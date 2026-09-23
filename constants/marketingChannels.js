// constants/marketingChannels.js
//
// THE GRAV-OWNED VOCABULARY FOR ADVERTISING AND MEASUREMENT CHANNELS.
//
// ── WHY THIS IS NOT IN constants/marketing.js ──────────────────────────────
// That file is the vocabulary of the internal marketing engine: consent,
// delivery, handovers, content. This is a different subject with a different
// visibility rule, and the difference is the whole point of the file.
//
// ── THE VISIBILITY RULE, WHICH IS NOT UNIFORM ──────────────────────────────
// Google Ads and Meta Ads are NAMED. A marketer chose to advertise there, pays
// those invoices and reconciles GRAV's numbers against those dashboards; hiding
// the name would not protect anything and would make every figure unverifiable.
// Google Analytics is named for the same reason.
//
// The email channel's engine is NOT named, ever. Nobody chose it, nobody signs
// into it, and it is an implementation detail GRAV may replace.
// `services/marketing/providerPrivacy.js` is the boundary that enforces that;
// this file simply never writes the name down in a label.
//
// So "name the provider" is not a policy this codebase applies uniformly, and
// the reason is in each entry rather than in a blanket rule somebody would
// later apply to the wrong one.
"use strict";

const pair = (code, label, extra = {}) => Object.freeze({ code, label, ...extra });
const codes = (list) => Object.freeze(list.map((x) => x.code));

/* ── WHAT A CHANNEL IS FOR ──────────────────────────────────────────────────
   A publisher can carry an advertisement. A measurement source cannot: it
   observes what happened and reports on it.

   Kept apart because the difference decides what GRAV may ask a channel for.
   Google Analytics has campaign rows and spend-shaped columns, and treating it
   as a fourth publisher would put its numbers beside Google Ads' own as though
   they were the same measurement of the same thing. They are not: one is what
   the ad platform billed, the other is what a tag observed in a browser. */
const CHANNEL_ROLES = [
  pair("advertising", "Advertising channel",
    { means: "GRAV can list campaigns here and read what they cost and produced." }),
  pair("measurement", "Measurement source",
    { means: "GRAV can read reported activity here. Nothing is published through it." }),
  pair("owned", "Owned channel",
    { means: "GRAV operates this channel itself. There is no external advertising account." }),
];

/* ── THE FOUR CHANNELS ──────────────────────────────────────────────────────
   `label` is what a marketer reads. `publisher` says who actually sends, and
   for `email` it is deliberately GRAV's own words: `marketing_engine`, the same
   token `providerPrivacy` publishes everywhere else. */
const MARKETING_CHANNELS = [
  pair("google_ads", "Google Ads", {
    role: "advertising",
    publisher: "google_ads",
    /* Named because the marketer holds the account and pays the invoice. */
    providerNamed: true,
    supports: Object.freeze({ accounts: true, campaigns: true, performance: true }),
  }),
  pair("meta_ads", "Meta Ads", {
    role: "advertising",
    publisher: "meta_ads",
    providerNamed: true,
    supports: Object.freeze({ accounts: true, campaigns: true, performance: true }),
  }),
  pair("google_analytics", "Google Analytics", {
    role: "measurement",
    publisher: null,
    providerNamed: true,
    /* No campaign inventory: a GA4 property has campaign-shaped REPORT ROWS, not
       campaigns. Asking it to "list campaigns" would return whatever campaign
       names a tag happened to observe, which is a report and not an inventory —
       it omits every campaign that ran and got no tracked traffic. */
    supports: Object.freeze({ accounts: true, campaigns: false, performance: true }),
  }),
  pair("email", "Email", {
    role: "owned",
    /* GRAV's own word. The engine behind it is never named publicly, and no
       label, code or state in this file carries its identity. */
    publisher: "marketing_engine",
    providerNamed: false,
    supports: Object.freeze({ accounts: false, campaigns: false, performance: false }),
  }),
];

/* ── THE SAFE CONNECTION STATES ─────────────────────────────────────────────
   Five, and `unknown` is one of them on purpose.

   The state a reader must never be given is a confident one GRAV did not earn.
   "GRAV has not checked" and "GRAV checked and the channel is fine" are
   different facts, and collapsing them into `ready` is how a screen tells
   somebody their advertising is connected because nothing has failed yet. */
const CHANNEL_STATES = [
  pair("ready", "Connected", {
    means: "GRAV holds working access and confirmed every capability this release needs by reading from the channel.",
  }),
  /* ── PARTLY CONNECTED IS A REAL STATE, NOT A ROUNDING ERROR ──────────────
     A channel whose account reads but whose reporting is refused is neither
     connected nor disconnected. Rounded up to `ready`, a marketer is told their
     advertising data is available and then sees a permanently empty performance
     screen. Rounded down to `unavailable`, they are told GRAV cannot see the
     channel at all while the campaign list in front of them plainly works.

     Its summary must name the capability that failed, and must say that the
     campaigns themselves may still be running and spending. */
  pair("partially_ready", "Partly connected", {
    means: "GRAV can reach this channel but one capability is unavailable. Some screens will have data and others will not.",
  }),
  pair("not_configured", "Not connected", {
    means: "No credentials are configured for this channel in this deployment.",
  }),
  pair("unavailable", "Temporarily unavailable", {
    means: "The channel did not answer. This says nothing about whether campaigns are running.",
  }),
  pair("access_refused", "Access refused", {
    means: "Credentials are configured and the channel declined them. Somebody must review the access.",
  }),
  pair("unknown", "Not checked", {
    means: "GRAV has not established the state of this channel.",
  }),
];

/* ── WHAT GRAV ACTUALLY CONFIRMED ───────────────────────────────────────────
   Three capabilities, checked and reported separately, because they fail
   separately and for different reasons.

   Reading an account can succeed while reporting is refused — Google Ads
   reporting needs an approved developer token that account access does not, and
   Meta separates `ads_read` from insights on some app review paths. One
   aggregate "connected" flag would call that combination healthy, and the first
   thing a marketer would notice is a permanently empty performance screen with
   no explanation anywhere. */
const CHANNEL_CAPABILITIES = [
  pair("accountRead", "Account access", { means: "GRAV can see the configured advertising account." }),
  pair("campaignRead", "Campaign list", { means: "GRAV can list the campaigns in that account." }),
  pair("reportingRead", "Performance reporting", { means: "GRAV can read what those campaigns cost and produced." }),
];

/* Each capability is one of these. `unsupported` is not a failure: a channel
   that publishes nothing has no campaign list to be broken. */
const CAPABILITY_STATES = [
  pair("confirmed", "Confirmed", { means: "GRAV performed this read successfully." }),
  pair("refused", "Refused", { means: "The channel declined this read." }),
  pair("unavailable", "Unavailable", { means: "The read could not be completed." }),
  pair("unsupported", "Not applicable", { means: "This channel does not offer this." }),
  pair("unknown", "Not checked", { means: "GRAV has not attempted this read." }),
];

/* ── THE NORMALISED CAMPAIGN STATUS ─────────────────────────────────────────
   Google and Meta each have their own status vocabulary and they do not line
   up. GRAV publishes BOTH: the provider's own word, unaltered, and this
   normalisation beside it.

   Publishing only the normalisation would make a marketer's screen disagree
   with the advertising dashboard they reconcile against and give them no way to
   see why. Publishing only the provider's word would make a mixed-channel list
   unsortable. `unknown` exists because a status GRAV does not recognise must
   not silently become `ended`, which reads as a decision somebody made. */
const CAMPAIGN_STATUSES = [
  pair("active", "Active", { means: "The channel reports this campaign as able to deliver." }),
  pair("paused", "Paused", { means: "The channel reports delivery as stopped by somebody." }),
  pair("scheduled", "Scheduled", { means: "Configured to start later." }),
  pair("ended", "Ended", { means: "Its schedule has finished." }),
  pair("draft", "Draft", { means: "Never activated." }),
  pair("removed", "Removed", { means: "Deleted or archived in the channel." }),
  pair("unknown", "Unknown", { means: "The channel reported a status GRAV does not recognise. It has not been guessed at." }),
];

/* Provider status → GRAV status. A closed table on purpose: an unmapped value
   becomes `unknown` and keeps its provider word, rather than being bucketed by
   a substring match that would one day read "REMOVED_BY_SYSTEM" as active. */
const GOOGLE_ADS_STATUS_MAP = Object.freeze({
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "removed",
});

const META_STATUS_MAP = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  DELETED: "removed",
  ARCHIVED: "removed",
  /* Meta's `effective_status` carries these three, which `status` does not.
     They are real states a marketer must be able to see. */
  CAMPAIGN_PAUSED: "paused",
  IN_PROCESS: "scheduled",
  WITH_ISSUES: "active",
});

/* ── HOW A NUMBER MAY BE ABSENT ─────────────────────────────────────────────
   Three states, and keeping them apart is the point of the performance
   contract.

   A zero is a measurement. `unavailable` means the read failed and nobody knows.
   `unsupported` means this channel does not report this number at all and never
   will. Rendering all three as `0` produces a screen that says a campaign spent
   nothing when the truth was that the API timed out. */
const METRIC_STATES = [
  pair("measured", "Measured", { means: "The channel reported this number, and it may legitimately be zero." }),
  pair("unavailable", "Unavailable", { means: "The read did not complete. This is not zero." }),
  pair("unsupported", "Not reported", { means: "This channel does not report this measurement." }),
];

/* ── WHO MEASURED A NUMBER ──────────────────────────────────────────────────
   Every published metric carries one of these.

   `provider_reported` is the advertising channel's own count, on its own
   definition. `analytics_reported` is a GA4 observation of a browser.
   `grav_derived` is arithmetic GRAV did on the two numbers above it. `grav_owned`
   is reserved for a GRAV business fact — a qualified prospect, a handover, an
   order — and NOTHING in this chunk emits it, because nothing in this chunk has
   earned it. */
const METRIC_SOURCES = [
  pair("provider_reported", "Reported by the channel", {
    means: "The advertising channel's own figure, on the channel's own definition.",
  }),
  pair("analytics_reported", "Reported by analytics", {
    means: "Observed by website analytics, not by the advertising channel. The two rarely agree exactly.",
  }),
  pair("grav_derived", "Calculated by GRAV", {
    means: "Arithmetic on the figures above. It inherits their definitions and their gaps.",
  }),
  pair("grav_owned", "GRAV business record", {
    means: "A commercial fact GRAV owns end to end.",
  }),
];

/* ── WHY CONVERSIONS ARE NOT ONE NUMBER ─────────────────────────────────────
   Google conversions, Meta conversions and GA4 conversions count different
   events, on different attribution windows, in different timezones. Adding
   them produces a number that is not wrong so much as meaningless.

   So GRAV publishes each channel's conversion figure under this label and does
   not total them across channels. When a GRAV-owned conversion definition
   exists — chunk 7's chain — that number will be `grav_owned` and comparable,
   and this one will still be here beside it. */
const CONVERSION_BASIS = [
  pair("provider_definition", "The channel's own definition", {
    means: "Counted by the advertising channel, on its own attribution window. Not comparable across channels.",
  }),
  pair("analytics_definition", "The analytics definition", {
    means: "Counted by website analytics on its own model. Not the same event as the channel's.",
  }),
  pair("grav_definition", "GRAV's definition", {
    means: "A GRAV business outcome. Comparable across channels because GRAV counts it the same way everywhere.",
  }),
];

/* ── THE READ STATE OF A COLLECTION ─────────────────────────────────────────
   Attached to every list and every per-channel block, because "no campaigns"
   and "GRAV could not ask" must never render the same way. An empty list is
   only meaningful when `readState` is `ok`. */
const READ_STATES = [
  pair("ok", "Read", { means: "The channel answered. An empty result here is a real empty result." }),
  pair("not_configured", "Not connected", { means: "No credentials, so nothing was asked." }),
  pair("access_refused", "Refused", { means: "The channel declined the read." }),
  pair("unavailable", "Unavailable", { means: "The channel did not answer, or answered unusably." }),
  pair("unsupported", "Not applicable", { means: "This channel has nothing of this kind to list." }),
];

/* ── BOUNDS ─────────────────────────────────────────────────────────────────
   Every one of these is enforced by refusing an out-of-range request rather
   than clamping it. A caller that asked for 500 rows and silently got 100 pages
   by an offset it believes it chose, and skips four hundred rows without an
   error ever appearing. */
const CAMPAIGN_PAGE_DEFAULT = 25;
const CAMPAIGN_PAGE_MAX = 100;

/* A report window. Ninety days because both providers charge differently for
   long windows and a caller asking for five years is almost always a mistake
   that would time out rather than answer. */
const REPORT_MAX_DAYS = 90;

/* Read timeouts, in milliseconds. Reads only — there are no writes in this
   chunk — so a retry is safe, and the retry budget is small because a marketer
   is waiting for a screen. */
const CHANNEL_TIMEOUT_MS = 15000;
const CHANNEL_RETRIES = 1;

module.exports = {
  CHANNEL_ROLES,
  CHANNEL_ROLE_CODES: codes(CHANNEL_ROLES),
  MARKETING_CHANNELS,
  MARKETING_CHANNEL_CODES: codes(MARKETING_CHANNELS),
  CHANNEL_STATES,
  CHANNEL_STATE_CODES: codes(CHANNEL_STATES),
  CHANNEL_CAPABILITIES,
  CHANNEL_CAPABILITY_CODES: codes(CHANNEL_CAPABILITIES),
  CAPABILITY_STATES,
  CAPABILITY_STATE_CODES: codes(CAPABILITY_STATES),
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_CODES: codes(CAMPAIGN_STATUSES),
  GOOGLE_ADS_STATUS_MAP,
  META_STATUS_MAP,
  METRIC_STATES,
  METRIC_STATE_CODES: codes(METRIC_STATES),
  METRIC_SOURCES,
  METRIC_SOURCE_CODES: codes(METRIC_SOURCES),
  CONVERSION_BASIS,
  READ_STATES,
  READ_STATE_CODES: codes(READ_STATES),
  CAMPAIGN_PAGE_DEFAULT,
  CAMPAIGN_PAGE_MAX,
  REPORT_MAX_DAYS,
  CHANNEL_TIMEOUT_MS,
  CHANNEL_RETRIES,
  channel: (code) => MARKETING_CHANNELS.find((c) => c.code === code) || null,
};
