// models/CMS_Models/Marketing/MarketingCampaignDeployment.js
//
// THE PERSISTENCE CONTRACT FOR A FUTURE PROVIDER WRITE. NOTHING CREATES ONE YET.
//
// ── DEFINED NOW, DELIBERATELY UNUSED ───────────────────────────────────────
// No route writes this. Approval does not create one, and neither does a readiness
// evaluation. A test asserts that the campaign-plan service, the readiness
// evaluator and every Marketing route load no writer for it.
//
// It exists now because the shape is a decision, and deciding it while nothing
// depends on it is the only time it can be decided calmly. It also settles a
// question the plan record would otherwise keep being asked to answer:
//
//   WHERE DOES A PROVIDER CAMPAIGN ID LIVE?
//
// Here, and only here. Never on the plan. That separation is what stops a GRAV plan
// from becoming a claim about somebody's advertising account — a plan says what
// was intended and approved; a deployment says what was created and what it was
// read back as.
//
// ── ATTEMPTS LIVE IN THEIR OWN FILE, AS TWO FACTS ──────────────────────────
// `MarketingCampaignDeploymentAttempt.js` holds them: an INTENT written before any
// external request and a RESULT written after it. A single immutable attempt row
// could not work, because it required its outcome at creation and the outcome does
// not exist until the request has finished — see that file for why the alternative,
// writing it only afterwards, loses track of real advertising objects.
//
// ── ONE ROW PER PLAN REVISION PER CHANNEL ──────────────────────────────────
// Not per plan: a plan can be deployed to two channels, and the two can succeed and
// fail independently. Not per plan either, without the revision: deploying revision
// 7 and later revision 9 are different acts on different content, and an audit that
// could not tell them apart would be an audit of nothing.
"use strict";

const mongoose = require("mongoose");

const {
  RECORDABLE_CAMPAIGN_TYPES: SUPPORTED_CAMPAIGN_TYPES, RECORDABLE_CAMPAIGN_TYPE_CODES: SUPPORTED_CAMPAIGN_TYPE_CODES, CHANNEL_SUPPORT,
} = require("../../../constants/marketingDeploymentReadiness");

/* ── ONLY THE CHANNELS THAT CARRY ADVERTISEMENTS ─────────────────────────────
   Not every marketing channel: `email` is operated by GRAV itself and
   `google_analytics` publishes nothing, so neither can ever be the subject of a
   deployment. Using the full channel list would have made a deployment to a
   measurement source a storable row. */
const DEPLOYMENT_CHANNEL_CODES = Object.freeze(Object.keys(CHANNEL_SUPPORT));

/* ── THE LIFECYCLE ───────────────────────────────────────────────────────────
   Six states, and the two in the middle are the ones that matter.

   `partially_created` exists because creating a campaign is creating several
   objects — a budget, a campaign, an ad group or ad set, a creative, an ad — and
   any of them can be the last one that succeeds. A deployment that stopped halfway
   has left real objects in somebody's advertising account, and a lifecycle with no
   word for that would force it to be recorded as either finished or failed. Both
   would be false, and the second would invite a retry that created a second set.

   `paused_confirmed` is the success state, and it is deliberately not called
   "created". Created is not the claim worth making: every object read back and
   confirmed paused is. */
const DEPLOYMENT_STATES = [
  "not_started",
  "preparing",
  "partially_created",
  "paused_confirmed",
  "failed",
  /* Set by a LATER chunk than the one that creates anything. Activation is the step
     that spends money and deserves its own authority; it is in this enum so the
     state machine is complete, not because this chunk or the next one may reach
     it. */
  "activated",
];

/* One external object GRAV created, and what it was read back as. */
const externalObjectSchema = new mongoose.Schema(
  {
    /* GRAV's word for what this is, not the provider's. `ad_group` and `ad_set`
       are the same rung of two different ladders, so both map onto `audience_group`
       and the provider's own term is recorded beside it. */
    role: {
      type: String,
      /* ── GRAV'S ROLES, NOT A PROVIDER'S ──────────────────────────────────
         `targeting_term` is a Google keyword and a Meta detailed-targeting
         entry: the same rung of two different ladders, so one GRAV word and
         the provider's own term recorded beside it. */
      enum: ["budget", "campaign", "audience_group", "creative", "advertisement", "targeting_term",
        /* Targeting rules on a campaign. They have no delivery state — the
           campaign's status decides that — and `location_target` is kept apart
           from `language_target` so evidence can show that an excluded place was
           stored as an exclusion. */
        "location_target", "language_target",
        /* A Google lead form and its link to the campaign. The link has a
           status of its own (PAUSED at creation); the form itself has none. */
        "lead_form", "lead_form_link"],
      required: true,
    },
    /* The provider's own id. THIS is the only place one is ever stored. */
    providerObjectId: { type: String, required: true, trim: true },
    providerObjectType: { type: String, trim: true, default: "" },

    /* ── WHAT IT WAS READ BACK AS, NOT WHAT WAS ASKED FOR ───────────────────
       A create that returns 200 is not a non-delivering object. These are set only
       after a separate read, and `stateReadAt` is when that read happened.

       `deliveryStateApplies` comes first because not every object has a delivery
       state at all: a campaign budget is a money object with no status saying
       whether anything is being shown. For those, `nonDeliveringConfirmed` stays
       null rather than false, because false would answer a question that was never
       asked — and marking a budget "paused" would be a fabrication. */
    deliveryStateApplies: { type: Boolean, required: true },

    /* ── WHAT THE AUTHOR ASKED FOR, BESIDE WHAT THE CHANNEL CALLS IT ─────────
       A criterion id is unreadable. Somebody reconciling a half-created campaign
       needs "India", not "2356", and needs to see the word they typed next to the
       one the channel resolved it to. */
    displayName: { type: String, trim: true, default: "", maxlength: 300 },
    requestedName: { type: String, trim: true, default: "", maxlength: 300 },

    /* ── TARGETED, OR AVOIDED ────────────────────────────────────────────────
       Null where the question does not apply — a budget, a campaign, an ad. For a
       location criterion it is the whole point: `negative` is what separates "run
       here" from "never run here", and the two are one dropped boolean apart.

       `negativeConfirmed` is the separate READ, like `nonDeliveringConfirmed`: the
       create response says what GRAV sent, not what the account holds. An
       exclusion that arrived as an inclusion is not a success, and this is the
       field that makes that detectable instead of invisible. */
    negative: { type: Boolean, default: null },
    negativeConfirmed: { type: Boolean, default: null },

    nonDeliveringConfirmed: { type: Boolean, default: null },
    stateReadAt: { type: Date, default: null },
    observedState: { type: String, trim: true, default: "" },

    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const deploymentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* The plan, by its internal id. The signed public identifier is a wire format
       and is minted from this. */
    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },

    /* ── THE EXACT APPROVED REVISION ─────────────────────────────────────────
       Which version of the plan this deployment is of. A plan edited after being
       deployed is a different document, and without this the deployment would
       silently claim to represent whatever the plan says today. */
    approvedRevision: { type: Number, required: true, min: 1 },

    channel: { type: String, enum: DEPLOYMENT_CHANNEL_CODES, required: true },
    /* One of the two supported types, and the validator below requires it to belong
       to the channel beside it. A Search campaign recorded against Meta Ads is a row
       that could only have come from a mapping bug, and it would be deployed. */
    campaignType: { type: String, enum: SUPPORTED_CAMPAIGN_TYPE_CODES, required: true },

    /* Supplied by the caller, so a retried deployment after a dropped connection
       continues rather than creating a second campaign. The same contract creation
       uses. */
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 128 },

    /* ── THE MARK, KEPT WHERE A RECONCILER WILL LOOK ─────────────────────────
       Same value as on every attempt intent for this deployment, because it is
       derived from the deployment command rather than from an attempt. Stored
       here too so that finding "what may exist in the account for this plan"
       needs one read rather than a walk through the attempt log. */
    deploymentMarker: { type: String, trim: true, default: "", maxlength: 80 },

    state: { type: String, enum: DEPLOYMENT_STATES, required: true, default: "not_started" },

    /* The current view of what exists externally, rolled up from the attempts. Kept
       separately because a retry needs to read it without replaying the log. */
    externalObjects: { type: [externalObjectSchema], default: [] },

    /* ── ATTEMPTS ARE NOT HERE ───────────────────────────────────────────────
       An embedded array's `pre("save")` hook claimed to enforce append-only and did
       not: it skipped a new document, it permitted rewriting the last existing
       attempt, and the query and bulk families bypass save hooks entirely. A false
       guarantee is worse than none, because code downstream trusts it.

       Attempts are now two append-only documents in
       `MarketingCampaignDeploymentAttempt.js` — an intent before the external
       request and a result after it. The rolled-up view a retry needs stays here, in
       `externalObjects`. */

    /* ── WHO APPROVED THE CONSEQUENTIAL STEP ─────────────────────────────────
       Separate from the plan's own approver. Approving a plan and authorising its
       deployment are two decisions, and a later chunk may require different people
       for them. */
    deploymentApprovedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
      role: { type: String, trim: true, default: "" },
      at: { type: Date, default: null },
    },

    /* Set when every delivery-capable object has been read back and confirmed not
       delivering. Not when creation returned. Supporting objects such as a budget
       are not asked, because they have no delivery state to confirm. */
    deliveryObjectsNonDeliveringConfirmedAt: { type: Date, default: null },

    /* ── AND NOTHING HERE ACTIVATES ──────────────────────────────────────────
       Present so the record can express it, and never set by the chunk that
       creates. Activation is its own chunk with its own authority and its own
       spend ceiling. */
    activatedAt: { type: Date, default: null },
    activatedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true, collection: "marketing_campaign_deployments" },
);

/* ── ONE DEPLOYMENT PER PLAN REVISION PER CHANNEL ────────────────────────────
   The uniqueness that makes a retry safe: a second attempt for the same plan
   revision and channel finds this row rather than creating a second campaign. */
deploymentSchema.index(
  { companyId: 1, campaignDraftId: 1, approvedRevision: 1, channel: 1 },
  { unique: true },
);

/* And by key, for the retry path. */
deploymentSchema.index({ companyId: 1, idempotencyKey: 1 }, { unique: true });

/* Operator reads: what is outstanding in this company. */
deploymentSchema.index({ companyId: 1, state: 1, updatedAt: -1 });

/* ── THE CHANNEL AND THE TYPE MUST AGREE ─────────────────────────────────────
   Both are individually valid values; the pair can still be nonsense. A validator
   rather than a comment, because this row is what a later chunk deploys from. */
deploymentSchema.pre("validate", function channelAndTypeAgree(next) {
  const spec = SUPPORTED_CAMPAIGN_TYPES.find((t) => t.code === this.campaignType);
  if (!spec) {
    return next(new Error(`marketing_campaign_deployments: ${this.campaignType} is not a campaign type GRAV deploys.`));
  }
  if (spec.channel !== this.channel) {
    return next(new Error(
      `marketing_campaign_deployments: ${spec.label} is a ${spec.channel} campaign type and this deployment names ${this.channel}.`,
    ));
  }
  return next();
});

/* ── A CONSEQUENTIAL STATE NEEDS AN IDENTIFIABLE AUTHORISER ──────────────────
   `preparing` onwards means something was or is being created in somebody's
   advertising account. That cannot be an anonymous act, and it cannot be one whose
   authorisation has no timestamp: an approval with no time is an approval nobody
   can place against what the plan said when it was given.

   `not_started` is exempt, so a row can be created to hold the intent before
   anybody authorises anything. */
const CONSEQUENTIAL_STATES = Object.freeze([
  "preparing", "partially_created", "paused_confirmed", "failed", "activated",
]);

deploymentSchema.pre("validate", function authorisationPresent(next) {
  if (!CONSEQUENTIAL_STATES.includes(this.state)) return next();
  const approver = this.deploymentApprovedBy || {};
  if (!approver.id || !approver.at) {
    return next(new Error(
      "marketing_campaign_deployments: a deployment cannot leave not_started without an identifiable approver and the time they approved it.",
    ));
  }
  return next();
});

const MarketingCampaignDeployment = mongoose.models.MarketingCampaignDeployment
  || mongoose.model("MarketingCampaignDeployment", deploymentSchema);

module.exports = {
  MarketingCampaignDeployment,
  DEPLOYMENT_STATES,
  DEPLOYMENT_CHANNEL_CODES,
  CONSEQUENTIAL_STATES,
};
