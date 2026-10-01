// models/CMS_Models/Marketing/MarketingCampaignDraft.js
//
// A GRAV CAMPAIGN PLAN, AND THE APPEND-ONLY RECORD OF WHAT HAPPENED TO IT.
//
// ── THIS IS A GRAV DOCUMENT, NOT A MIRROR OF AN EXTERNAL CAMPAIGN ──────────
// Nothing here holds a provider campaign id, a provider account id, an access
// token or any other provider credential. Not as an optional field, not as a
// nullable one, not "for later". The deployment chunk that creates a real
// external campaign will add its own record linking a plan to what it produced,
// and keeping those apart is what stops a plan from quietly becoming a claim
// about an advertising account.
//
// Two collections:
//
//   marketing_campaign_drafts         the current plan, one row, revision-carrying
//   marketing_campaign_draft_history  one row per change, append-only
//
// ── WHY MONEY IS NEVER A BARE NUMBER ───────────────────────────────────────
// A budget of 50000 is meaningless. It is ₹50,000 or $50,000 or ¥50,000, and the
// difference is two orders of magnitude. So the amount and its currency are one
// required sub-document, and a schema-level check refuses an amount without a
// currency rather than letting a caller store a number somebody will later add to
// a differently-denominated one.
"use strict";

const mongoose = require("mongoose");

const {
  DRAFT_STATE_CODES, CAMPAIGN_OBJECTIVE_CODES, CONVERSION_GOAL_CODES,
  HISTORY_KIND_CODES, LIMITS,
} = require("../../../constants/marketingCampaignDrafts");
const { MARKETING_CHANNEL_CODES } = require("../../../constants/marketingChannels");
const { CONTENT_KIND_CODES } = require("../../../constants/marketing");
const {
  RECORDABLE_CAMPAIGN_TYPE_CODES, BIDDING_STRATEGY_CODES, BUDGET_RELATIONSHIP_CODES,
  DESTINATION_KIND_CODES, EXCLUSION_DECISION_CODES, BRIEF_LIMITS,
} = require("../../../constants/marketingDeploymentReadiness");

/* ── MONEY ──────────────────────────────────────────────────────────────────
   Both fields required together. Mongoose validates a sub-document's required
   fields only when the sub-document exists, which is exactly the behaviour
   wanted: a plan may have no budget yet, and a plan with half a budget may not
   exist. */
const moneySchema = new mongoose.Schema(
  {
    /* Stored as the author entered it, in whole currency units. NOT converted to
       minor units here: the advertising adapters already deal in three different
       provider conventions, and adding a fourth internal one would mean four
       conversions to keep straight instead of three. The deployment chunk
       converts once, at the boundary, where the provider's convention is known. */
    amount: { type: Number, required: true, min: 0 },
    /* ISO 4217. Upper-cased on the way in so `inr` and `INR` are one currency
       rather than two groups in a report. */
    currency: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 3 },
    /* Whether this is the whole campaign's budget or a daily rate. The two are
       not interchangeable and a plan that does not say which is a plan somebody
       will read the wrong way — a ₹50,000 daily budget is a ₹1.5m month. */
    basis: { type: String, enum: ["total", "daily"], required: true },
  },
  { _id: false },
);

/* ── A CONTENT REFERENCE ────────────────────────────────────────────────────
   The GRAV `contentId` contract from the content inventory, and nothing else. A
   kind plus an opaque identifier GRAV published. No URL, no HTML, no subject
   line copied in — those live in the content library, and duplicating them here
   would create a second copy that drifts from the first.

   `capturedName` is the one exception, and it is deliberately labelled as a
   snapshot: an approver reading a plan needs to know which asset they agreed to,
   and resolving fifty content ids at read time to render a list is a read that
   fails when the library is unavailable. It is what the name WAS, not what it is. */
const contentRefSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: CONTENT_KIND_CODES, required: true },
    contentId: { type: String, required: true, trim: true, maxlength: 200 },
    capturedName: { type: String, trim: true, default: "", maxlength: 300 },
    capturedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/* Who did something. A snapshot, because an employee record can be renamed or
   deactivated and an audit row must still say who acted. */
const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    role: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/* ── THE PROVIDER-NEUTRAL DEPLOYMENT BRIEF ───────────────────────────────────
   What somebody would have to decide before an advertising campaign could be
   prepared, in GRAV's own words. One brief per selected channel.

   ── WHY IT IS PER-CHANNEL AND NOT ONE SHARED SHAPE ────────────────────────
   Google and Meta genuinely need different information, and the differences are not
   cosmetic. Google Search takes several headlines and several descriptions that it
   assembles itself; Meta's single-image advertisement takes one primary text, one
   headline and one image. Meta can attach a budget to an audience; Google cannot.
   Forcing those into shared fields would mean either a `headlines` array that is
   always length one for Meta, or a `primaryText` that Google ignores — and in both
   cases a reader cannot tell a deliberate value from a filler one.

   So the common decisions are shared and the channel-specific ones live under a
   discriminated block. `channel` says which block is the real one.

   ── AND IT HOLDS NOTHING A PROVIDER OWNS ──────────────────────────────────
   No campaign, ad-set, ad-group or creative id. No advertising-account id. No access
   token. No embedded script. No provider API path. Those belong to the deployment
   record a later chunk adds, and keeping them out of the plan is what stops a plan
   from becoming a claim about an advertising account. The write boundary refuses
   them by name and a test asserts it.

   A brief is part of the plan, so editing one obeys the same editable-state and
   revision rules as any other field: a submitted plan's brief is frozen. */

/* A place a campaign may target or exclude, named rather than coded. GRAV does not
   hold a geography table, and inventing codes here would mean a mapping layer that
   drifts from both providers. The deployment chunk resolves these names against each
   channel's own geo targets and refuses the ones it cannot. */
const namedTargetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: BRIEF_LIMITS.GEO_NAME_MAX },
    /* What kind of thing the name is, so a resolver knows what to look for rather
       than guessing from the string. */
    kind: {
      type: String,
      enum: ["country", "region", "city", "postal_area", "radius"],
      required: true,
    },
    note: { type: String, trim: true, default: "", maxlength: 200 },
  },
  { _id: false },
);

const audienceTargetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: BRIEF_LIMITS.AUDIENCE_NAME_MAX },
    kind: {
      type: String,
      enum: ["interest", "behaviour", "demographic", "custom_list", "lookalike", "search_intent"],
      required: true,
    },
    note: { type: String, trim: true, default: "", maxlength: 200 },
  },
  { _id: false },
);

/* Where a click goes. Either a content-library landing page, identified by the same
   `contentId` contract the inventory publishes, or a URL on the company site. */
const destinationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: DESTINATION_KIND_CODES, required: true },
    /* Present for a content-library page. The opaque identifier, never a provider
       path. */
    contentId: { type: String, trim: true, default: "" },
    /* Present for a site URL. Stored as given; the deployment chunk appends the
       tracking parameters. */
    url: { type: String, trim: true, default: "", maxlength: BRIEF_LIMITS.DESTINATION_URL_MAX },
    capturedName: { type: String, trim: true, default: "", maxlength: 300 },
  },
  { _id: false },
);

const biddingSchema = new mongoose.Schema(
  {
    strategy: { type: String, enum: BIDDING_STRATEGY_CODES, required: true },
    /* Required by some strategies and meaningless to others. Money, so it carries
       its currency — a target of 40 is not a target. */
    target: {
      amount: { type: Number, default: null, min: 0 },
      currency: { type: String, trim: true, uppercase: true, default: "" },
    },
  },
  { _id: false },
);

/* ── GOOGLE SEARCH CREATIVE ──────────────────────────────────────────────────
   Several headlines and descriptions, which Google assembles. Stored as the author
   wrote them; the count is checked by the evaluator against what the channel will
   not create without. */
const googleCreativeSchema = new mongoose.Schema(
  {
    headlines: { type: [{ type: String, trim: true, maxlength: BRIEF_LIMITS.HEADLINE_MAX }], default: [] },
    descriptions: { type: [{ type: String, trim: true, maxlength: BRIEF_LIMITS.BODY_MAX }], default: [] },
    /* The search terms this campaign should appear for, as the author's words. Not
       match types: those are a Google concept the deployment chunk maps. */
    keywordThemes: { type: [{ type: String, trim: true, maxlength: 120 }], default: [] },
  },
  { _id: false },
);

/* ── THE GOOGLE LEAD FORM ────────────────────────────────────────────────────
   Carried only by a `google_lead_form` brief, beside its Search creative (the
   advertisement and keywords a lead-form campaign still needs). Google's field
   names are applied at mapping; this is GRAV's shape. No delivery address, no
   secret and no provider id is ever stored here — the address belongs to the
   delivery binding and the secret is derived, never kept. */
const googleLeadFormSchema = new mongoose.Schema(
  {
    businessName: { type: String, trim: true, default: "", maxlength: 100 },
    headline: { type: String, trim: true, default: "", maxlength: 100 },
    description: { type: String, trim: true, default: "", maxlength: 500 },
    callToAction: { type: String, trim: true, default: "", maxlength: 40 },
    callToActionDescription: { type: String, trim: true, default: "", maxlength: 100 },
    privacyPolicyUrl: { type: String, trim: true, default: "", maxlength: 2048 },
    postSubmitHeadline: { type: String, trim: true, default: "", maxlength: 100 },
    postSubmitDescription: { type: String, trim: true, default: "", maxlength: 500 },
    postSubmitCallToAction: { type: String, trim: true, default: "", maxlength: 40 },
    /* Google's own input-type codes, in the order the form asks them. */
    fields: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    qualifyingQuestions: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
  },
  { _id: false },
);

/* ── META SINGLE-IMAGE CREATIVE ──────────────────────────────────────────────
   One primary text, one headline, one call to action, one image. */
const metaCreativeSchema = new mongoose.Schema(
  {
    primaryText: { type: String, trim: true, default: "", maxlength: BRIEF_LIMITS.BODY_MAX },
    headline: { type: String, trim: true, default: "", maxlength: BRIEF_LIMITS.HEADLINE_MAX },
    callToAction: { type: String, trim: true, default: "", maxlength: BRIEF_LIMITS.CALL_TO_ACTION_MAX },
    /* The image, as a content reference. The library does not hold an advertising
       media kind yet, which is recorded honestly: the evaluator treats resolving
       this as an EXTERNAL check rather than claiming it confirmed the asset. */
    image: {
      kind: { type: String, enum: [...CONTENT_KIND_CODES, ""], default: "" },
      contentId: { type: String, trim: true, default: "" },
      capturedName: { type: String, trim: true, default: "", maxlength: 300 },
    },
  },
  { _id: false },
);

const deploymentBriefSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: MARKETING_CHANNEL_CODES, required: true },
    /* The supported type, or empty while the author has not chosen. An unsupported
       value cannot be stored: the write boundary refuses it by name rather than
       accepting something the evaluator would then have to reject. */
    /* Deployable types and the controlled ones; the capability matrix, not
       this enum, decides what is offered. */
    campaignType: { type: String, enum: [...RECORDABLE_CAMPAIGN_TYPE_CODES, ""], default: "" },

    destination: { type: destinationSchema, default: null },

    geoTargeting: { type: [namedTargetSchema], default: [] },

    /* ── PLACES THE CAMPAIGN MUST NOT REACH ──────────────────────────────────
       Kept apart from `exclusions`, which are AUDIENCE exclusions. They are not
       the same kind of thing and they are not applied the same way: an audience
       exclusion narrows who sees an ad within a place, and a location exclusion
       says the ad must not be shown in that place at all.

       One list, because collapsing the two would mean a plan that excludes a city
       and a plan that excludes an interest list are stored identically, and the
       mapper would have to guess which kind each entry was. Guessing wrong turns
       an exclusion into an inclusion, which is a campaign spending money in the
       one place somebody said not to. */
    geoExclusions: { type: [namedTargetSchema], default: [] },
    /* BCP-47 style tags as the author supplied them. Validated for shape, resolved
       against each channel's own language list at deployment. */
    languages: { type: [{ type: String, trim: true, maxlength: 12 }], default: [] },

    audiences: { type: [audienceTargetSchema], default: [] },
    /* The decision, and then the list. A list is only meaningful once somebody has
       decided there should be one. */
    exclusionDecision: { type: String, enum: [...EXCLUSION_DECISION_CODES, ""], default: "" },
    exclusions: { type: [audienceTargetSchema], default: [] },

    bidding: { type: biddingSchema, default: null },
    budgetRelationship: { type: String, enum: [...BUDGET_RELATIONSHIP_CODES, ""], default: "" },

    /* ── THE TWO META DECISIONS THAT HAVE NO SAFE DEFAULT ────────────────────
       Both have a provider default, and both defaults are consequential.

       `metaOptimisation` decides what the budget actually buys: an objective of
       website traffic still leaves the channel a choice between optimising for
       clicks and for page views, and those are different things bought with the
       same money.

       `specialAdCategory` is the sharper one. The channel restricts targeting
       for advertisements about credit, employment, housing and social issues,
       and its default is "none of these". A recruitment campaign declared as
       none is a policy violation and, in several jurisdictions, a legal one —
       and nobody discovers it from a screen. GRAV will not answer on somebody's
       behalf, so an empty value blocks deployment rather than defaulting. */
    metaOptimisation: { type: String, trim: true, default: "", maxlength: 40 },
    specialAdCategory: { type: String, trim: true, default: "", maxlength: 40 },

    /* ── GOOGLE'S EU POLITICAL-ADVERTISING DECLARATION ──────────────────────
       The Google counterpart of `specialAdCategory`: required by Google on
       every new campaign, a statement with legal weight, and one GRAV will not
       make for the advertiser. `does_not_contain` or `contains`; empty blocks
       deployment rather than defaulting. */
    euPoliticalAdvertising: { type: String, trim: true, default: "", maxlength: 40 },

    /* ── THE AUDIENCE, AND WHY EVERY PART OF IT IS STORED SEPARATELY ─────────
       One supported mode — deliberately broad prospecting — and every boundary
       on it stated by a person.

       The distinction this shape exists to hold: "broad" must mean somebody
       decided to reach a wide audience within named limits. It must NOT mean
       GRAV omitted fields and the channel filled them in. Those two produce
       campaigns that look identical and cost very different amounts, and a
       plan that never considered gender would be indistinguishable from one
       that deliberately chose everyone.

       So `audienceGenders` has an explicit `all`, and an empty value is a plan
       that has not decided rather than a plan that chose everybody. Ages are
       numbers, and `null` means unanswered — not "the channel's default". */
    audienceMode: { type: String, trim: true, default: "", maxlength: 40 },
    audienceAgeMin: { type: Number, default: null, min: 0 },
    audienceAgeMax: { type: Number, default: null, min: 0 },
    audienceGenders: { type: String, trim: true, default: "", maxlength: 20 },

    /* ── THE EXPANSION SETTINGS, RECORDED AS REFUSED ─────────────────────────
       The channel can show an advertisement to people OUTSIDE the audience that
       was approved. GRAV never enables it, and stores the answer rather than
       leaving the field absent — an absent field is what a future mapper would
       omit, and omitting it is how the channel's own default wins. */
    audienceExpansionRequested: { type: Boolean, default: false },

    /* ── THE APPROVED ADVERTISING IMAGE, BY ITS PUBLIC IDENTIFIER ────────────
       A signed token from the advertising image library, not a content-library
       reference and not a URL. The library is the only place an image can come
       from, and `forDeployment` there is the only door — it refuses anything
       that is not an approved, current version belonging to this company.

       Stored as the opaque identifier rather than an internal id so that a plan
       document carries nothing that could be used to reach storage directly. */
    advertisingAssetId: { type: String, trim: true, default: "", maxlength: 300 },

    /* Exactly one of these is the real one, decided by `channel`. */
    googleSearch: { type: googleCreativeSchema, default: null },
    googleLeadForm: { type: googleLeadFormSchema, default: null },
    metaSingleImage: { type: metaCreativeSchema, default: null },

    /* Content the campaign needs beyond its destination and image — a form the
       landing page embeds, for instance. The same `contentId` contract. */
    contentRefs: { type: [contentRefSchema], default: [] },

    /* ── THE TIMEZONE IS THE CAMPAIGN'S, AND IS REQUIRED ──────────────────────
       The plan's dates are calendar days. A day means a different set of hours in
       each advertising account, and a campaign deployed without saying which
       timezone its schedule is in starts and stops up to a day away from what
       somebody intended. */
    timezone: { type: String, trim: true, default: "", maxlength: BRIEF_LIMITS.TIMEZONE_MAX },

    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const draftSchema = new mongoose.Schema(
  {
    /* ── EVERY SELECTOR CARRIES THIS ─────────────────────────────────────────
       Not indexed alone — it is the first key of every compound index below, and
       a standalone index on a field that appears in every query as the leading
       term earns nothing and costs a write. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* ── THE HUMAN-READABLE REFERENCE ────────────────────────────────────────
       `MCP-2026-0001`. Company-scoped and sequential, so two companies both have
       an 0001 and neither can infer the other's volume from it. The PUBLIC
       identifier is a signed token minted from this plus the company; see
       `services/marketing/campaignDrafts/draftIdentity.js`. */
    draftRef: { type: String, required: true, trim: true },

    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME_MAX },
    objective: { type: String, enum: CAMPAIGN_OBJECTIVE_CODES, required: true },
    description: { type: String, trim: true, default: "", maxlength: LIMITS.DESCRIPTION_MAX },

    /* ── AT LEAST ONE CHANNEL, ALWAYS ────────────────────────────────────────
       A campaign with no channel is not a campaign. Enforced here as well as in
       the service, because the service is one caller and the schema is the last
       line. */
    channels: {
      type: [{ type: String, enum: MARKETING_CHANNEL_CODES }],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 1 && v.length <= LIMITS.CHANNELS_MAX,
        message: "A campaign plan needs at least one channel.",
      },
    },

    /* ── THE AUDIENCE IS A REFERENCE, NOT A COPY ─────────────────────────────
       A free-text reference to the audience this campaign is for, plus the
       qualification reasoning. Deliberately NOT a list of people: a campaign
       plan that embedded contacts would become a second audience definition
       competing with the one the marketing engine holds, and it would be stale
       the day after it was written. */
    audience: {
      reference: { type: String, trim: true, default: "", maxlength: LIMITS.AUDIENCE_REF_MAX },
      qualificationNotes: { type: String, trim: true, default: "", maxlength: LIMITS.QUALIFICATION_NOTES_MAX },
    },

    contentRefs: { type: [contentRefSchema], default: [] },

    /* Calendar dates, stored as the `YYYY-MM-DD` strings they were given as.
       NOT Date objects: a campaign runs from a day in an advertising account's
       own timezone, and storing an instant would make the stored value depend on
       the server's timezone at write time. */
    schedule: {
      startDate: { type: String, trim: true, default: "" },
      endDate: { type: String, trim: true, default: "" },
    },

    budget: { type: moneySchema, default: null },

    conversionGoal: { type: String, enum: CONVERSION_GOAL_CODES, default: null },

    /* The campaign identity that will appear in destination URLs. Unique per
       company: two campaigns sharing one would make their analytics one
       indistinguishable row, which is the whole failure this field prevents. */
    utmCampaign: { type: String, trim: true, lowercase: true, default: "", maxlength: LIMITS.UTM_MAX },

    owner: { type: actorSchema, required: true },

    state: { type: String, enum: DRAFT_STATE_CODES, required: true, default: "draft" },

    /* ── OPTIMISTIC CONCURRENCY ──────────────────────────────────────────────
       Every write states the revision it believes it is replacing. Two marketers
       editing one plan is the ordinary case, and a lost update here means
       somebody's budget change silently disappears. */
    revision: { type: Number, required: true, default: 1, min: 1 },

    /* ── THE LIFECYCLE TIMESTAMPS, EACH EARNED ───────────────────────────────
       Written only by the transition that earns them, never at creation. A
       `submittedAt` set when a plan was created would make every draft look
       submitted to any query that tested for its presence. */
    submittedAt: { type: Date, default: null },
    submittedBy: { type: actorSchema, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: actorSchema, default: null },
    decisionReason: { type: String, trim: true, default: "", maxlength: LIMITS.DECISION_REASON_MAX },
    cancelledAt: { type: Date, default: null },

    /* ── ONE BRIEF PER SELECTED CHANNEL ──────────────────────────────────────
       Keyed by channel in the application layer rather than a Map here, because a
       Mongoose Map of sub-documents does not validate its values' enums reliably
       across versions and this schema's enums are load-bearing. An array with a
       unique channel, enforced by the write boundary. */
    deploymentBriefs: { type: [deploymentBriefSchema], default: [] },

    /* ── THE DEPLOYMENT BOUNDARY, STATED IN THE RECORD ───────────────────────
       Always false in this chunk, and nothing here can set it true. It exists so
       the next chunk has one field to flip under its own audit, and so a reader
       of this collection can see that approval and deployment are two different
       facts rather than inferring it from an absence. */
    deployed: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "marketing_campaign_drafts" },
);

/* One reference per company. The partial filter is unnecessary here — every row
   has a ref — but the company must lead, or a second company's 0001 collides. */
draftSchema.index({ companyId: 1, draftRef: 1 }, { unique: true });

/* ── ONE UTM IDENTITY PER COMPANY, FOR EVER ─────────────────────────────────
   The first version scoped this to live plans, so cancelling or rejecting a plan
   released its campaign identity for reuse. That was wrong, and it was wrong in a
   way that only shows up later: the moment any plan has EVER been deployed, its
   identity exists in Google's and Meta's click data and in every analytics report
   covering that period. Reusing it attaches a new campaign's sessions to the old
   campaign's history, and the merged row looks perfectly plausible — nobody
   discovers it by reading a screen.

   Cancelled and rejected plans therefore keep their identity permanently. The
   cost is that a typo'd identity is spent; the alternative is silently corrupted
   attribution, which is not a trade.

   The partial filter keeps only the "" case out, so the many plans with no
   identity yet do not all collide. Named explicitly, because this REPLACES an
   earlier index with the same keys and different options — see
   `scripts/migrations/marketing-campaign-draft-utm-index.js` for why a declaration
   change alone leaves the old constraint live in an existing database. */
draftSchema.index(
  { companyId: 1, utmCampaign: 1 },
  {
    name: "companyId_1_utmCampaign_1_permanent",
    unique: true,
    partialFilterExpression: { utmCampaign: { $type: "string", $gt: "" } },
  },
);

/* The list read: a company's plans, newest first, filterable by state. */
draftSchema.index({ companyId: 1, state: 1, createdAt: -1 });
draftSchema.index({ companyId: 1, createdAt: -1 });

/* ── A BUDGET IS AN AMOUNT AND A CURRENCY, OR IT IS NOTHING ─────────────────
   Belt and braces over the sub-document's own `required`: a caller that builds
   the sub-document with `{ amount: 5 }` gets a validation error naming the
   currency, rather than a stored row whose currency defaulted to empty. */
draftSchema.path("budget").validate(function budgetIsComplete(value) {
  if (value === null || value === undefined) return true;
  return Number.isFinite(value.amount) && value.amount >= 0
    && typeof value.currency === "string" && value.currency.length === 3
    && (value.basis === "total" || value.basis === "daily");
}, "A budget needs an amount, a three-letter currency and a basis of total or daily.");

/* ── THE HISTORY ────────────────────────────────────────────────────────────
   Append-only, one row per change, and the append-only part is enforced rather
   than documented. A history somebody can edit is a history, not an audit trail,
   and the first time it matters is the time somebody wants it changed.

   `before` and `after` hold the fields that moved, not whole documents: a full
   snapshot per edit would store the description fifty times and make the diff
   the reader actually wants something they have to compute. */
const historySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* The draft's own `_id`, not its public identifier — a history row is
       internal and joins on the internal key. */
    draftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },

    kind: { type: String, enum: HISTORY_KIND_CODES, required: true },

    /* The revision this change PRODUCED. Unique per draft, which is what makes
       the sequence gap-free and makes a duplicate write impossible rather than
       merely unlikely. */
    revision: { type: Number, required: true, min: 1 },

    fromState: { type: String, enum: [...DRAFT_STATE_CODES, null], default: null },
    toState: { type: String, enum: DRAFT_STATE_CODES, required: true },

    /* Which fields changed, and their values either side. Only the fields that
       actually moved — a reader wants the diff, not two full documents. */
    changedFields: { type: [String], default: [] },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },

    /* ── THE CANONICAL PLAN AT THIS REVISION ───────────────────────────────
       The COMPLETE plan as this revision left it, not a diff. This is what makes
       the history-first protocol a repair rather than a guess: if the process
       stops between this row and the current record, `resulting` holds exactly
       what the current record was supposed to become, and applying it is
       deterministic.

       A diff could not do that. Replaying diffs requires every earlier row to be
       present and correctly ordered, and the one situation this exists for is the
       one where a write was interrupted. */
    resulting: { type: mongoose.Schema.Types.Mixed, required: true },

    reason: { type: String, trim: true, default: "", maxlength: LIMITS.DECISION_REASON_MAX },
    actor: { type: actorSchema, required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { collection: "marketing_campaign_draft_history" },
);

/* ── (draft, revision) IS THE IDEMPOTENCY KEY ───────────────────────────────
   A retried transition computes the same target revision and collides here, so a
   duplicate submission writes one row rather than two. The unique index does
   that under concurrency; a read-then-write check does not. */
historySchema.index({ companyId: 1, draftId: 1, revision: 1 }, { unique: true });
historySchema.index({ companyId: 1, draftId: 1, at: 1 });

/* ── APPEND-ONLY, ENFORCED ──────────────────────────────────────────────────
   Mongoose's update helpers bypass `pre("save")` entirely, so blocking only the
   save hook would leave `updateOne` and `findOneAndUpdate` wide open. Both paths
   are closed: the mutating query middlewares throw, and the save hook refuses a
   re-save of a document that already exists. */
const refuseMutation = function refuseHistoryMutation(next) {
  next(new Error("marketing_campaign_draft_history is append-only: history rows cannot be updated or deleted."));
};

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove",
]) {
  historySchema.pre(op, refuseMutation);
}

historySchema.pre("save", function refuseHistoryResave(next) {
  if (!this.isNew) {
    return next(new Error("marketing_campaign_draft_history is append-only: an existing row cannot be re-saved."));
  }
  return next();
});

const MarketingCampaignDraft = mongoose.models.MarketingCampaignDraft
  || mongoose.model("MarketingCampaignDraft", draftSchema);

const MarketingCampaignDraftHistory = mongoose.models.MarketingCampaignDraftHistory
  || mongoose.model("MarketingCampaignDraftHistory", historySchema);

module.exports = { MarketingCampaignDraft, MarketingCampaignDraftHistory };
